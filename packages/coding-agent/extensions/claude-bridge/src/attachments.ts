// Carrying Claude Code's own attachments across a session rebuild.
//
// CC expands an `@file` mention itself — pi passes `@` through untouched — and
// writes the expansion as a `type: "attachment"` record in its session file. pi
// never sees it, so rebuilding a session from pi's history drops the file while
// keeping the prompt text that referred to it: the model silently loses
// something it was reasoning about, with nothing logged.
//
// Extracted from index.ts so tests can import it without activating the extension.

import type { ImportAttachment, JsonlRecord } from "cc-session-io";
import { messageContentToText } from "./convert.ts";
import { userSideContent } from "./native-prefix.ts";

// Only `@file` expansions are carried. They are the one thing pi genuinely never
// sees, so a rebuild is the only chance to keep them.
//
// `edited_text_file` is deliberately excluded even though it also carries file
// content. CC writes one after editing a file, and the edit itself is already in
// pi's history as a tool call and its result, so the attachment duplicates context
// the rebuild reproduces anyway. It also usually hangs off a *tool result* record
// rather than a prompt, which has no position in the ordinal scheme below — on
// real sessions that left 81 of them unresolvable (see
// diag/attachment-coverage.mjs). Half-carrying a kind is worse than not claiming
// it: the ones that slipped through would be an arbitrary subset.
//
// Everything else CC rewrites every turn (`skill_listing`, `task_reminder`,
// `agent_listing_delta`, `mcp_instructions_delta`, …) and loses nothing.
const CONTENT_BEARING = new Set(["file"]);

export type CarriedAttachment = {
	attachment: { type: string; [key: string]: unknown };
	/** Position of the parent's prompt among the session's prompts. */
	userOrdinal: number;
	/** That prompt's text, to verify the ordinal still points at the same turn. */
	parentText: string;
};

type Rec = Record<string, unknown>;

/**
 * The prompt text user-side content carries: its text outside tool results.
 *
 * CC and pi agree on prompts only at this granularity. Each side counts a run of
 * consecutive prompt-bearing user content as one prompt joined with "\n", the way
 * the bridge sends a turn of several pi messages and the API merges them. A
 * repaired message holding a synthetic result and the next prompt counts by its
 * text, which is what CC keeps after importMessages splits it in two.
 */
function promptText(content: unknown): string {
	const blocks = Array.isArray(content) ? content.filter((block) => (block as Rec)?.type !== "tool_result") : content;
	return messageContentToText(blocks as never);
}

/** A user message, or a steer CC queued mid-turn, as pi records one too. */
function recordPromptText(record: Rec): string {
	return record.type === "user" || record.type === "attachment" ? promptText(userSideContent(record)) : "";
}

/** Joins `text` onto the open turn's prompt or starts a new one; returns its ordinal. */
function addPrompt(prompts: string[], turnOpen: boolean, text: string): number {
	if (turnOpen && prompts.length) prompts[prompts.length - 1] += `\n${text}`;
	else prompts.push(text);
	return prompts.length - 1;
}

/**
 * Content-bearing attachments in a session, each tagged with where its parent
 * prompt sits among the session's prompts.
 *
 * The ordinal is the mapping key rather than the record index: a rebuild does not
 * reproduce the old record list one-for-one — `importMessages` splits a message
 * carrying tool results into two records, and CC appends records of its own — but
 * the sequence of user prompts is the same conversation either way.
 *
 * Attachments also chain to one another, so an ordinal is resolved transitively up
 * the parent links until it reaches a prompt. Most real attachments are
 * `edited_text_file` records CC writes after editing a file, which have nothing to
 * do with at-mentions; only their position in the conversation matters here.
 */
export function collectCarriedAttachments(records: readonly JsonlRecord[]): CarriedAttachment[] {
	const ordinalOf = new Map<string, number>();
	const prompts: string[] = [];
	let turnOpen = false;
	const carried: Omit<CarriedAttachment, "parentText">[] = [];

	for (const raw of records) {
		const record = raw as Rec;
		if (record.type === "assistant") {
			turnOpen = false;
			continue;
		}
		const text = recordPromptText(record);
		if (text) {
			ordinalOf.set(record.uuid as string, addPrompt(prompts, turnOpen, text));
			turnOpen = true;
			continue;
		}
		if (record.type !== "attachment") continue;
		const parent = record.parentUuid as string | null;
		// Attachments chain to each other — a run of them hangs off one prompt, and
		// 63 of 179 in real sessions parent to another attachment rather than to a
		// message. Inherit the ordinal so the whole run keys to the prompt that
		// caused it. Recorded for every attachment, not just the ones carried, since
		// a content-bearing one can chain off a `skill_listing` we ignore.
		if (parent === null) continue;
		const inherited = ordinalOf.get(parent);
		if (inherited === undefined) continue;
		ordinalOf.set(record.uuid as string, inherited);

		const attachment = record.attachment as { type: string; [key: string]: unknown } | undefined;
		if (!attachment || !CONTENT_BEARING.has(attachment.type)) continue;
		carried.push({ attachment, userOrdinal: inherited });
	}
	return carried.map((item) => ({ ...item, parentText: prompts[item.userOrdinal] ?? "" }));
}

/**
 * Resolve each carried attachment to a position in the array about to be
 * imported — the messages *after* conversion and repair, since that is the index
 * space `importMessages` reads. Repair is idempotent, so an already-repaired array
 * passes through its second run unchanged and the indices stay valid.
 *
 * Deliberately conservative: attaching a file to the wrong turn tells the model it
 * saw something at a point it did not, which is worse than the loss this exists to
 * prevent. So the ordinal has to land on a prompt whose text still matches; any
 * disagreement is reported and dropped rather than approximated.
 */
export function placeCarriedAttachments(
	carried: readonly CarriedAttachment[],
	messages: readonly { role: string; content: unknown }[],
): { attachments: ImportAttachment[]; skipped: string[] } {
	const prompts: string[] = [];
	// Index of each prompt's last message, which its attachments follow.
	const lastIndex: number[] = [];
	let turnOpen = false;
	messages.forEach((msg, index) => {
		if (msg.role !== "user") {
			turnOpen = false;
			return;
		}
		const text = promptText(msg.content);
		if (!text) return;
		lastIndex[addPrompt(prompts, turnOpen, text)] = index;
		turnOpen = true;
	});

	const attachments: ImportAttachment[] = [];
	const skipped: string[] = [];
	for (const item of carried) {
		const name = String(item.attachment.filename ?? item.attachment.type);
		const candidate = prompts[item.userOrdinal];
		if (candidate === undefined) {
			skipped.push(`${name}: prompt #${item.userOrdinal} is no longer in history`);
			continue;
		}
		if (candidate !== item.parentText) {
			skipped.push(`${name}: prompt #${item.userOrdinal} changed`);
			continue;
		}
		attachments.push({ afterIndex: lastIndex[item.userOrdinal] as number, attachment: item.attachment });
	}
	return { attachments, skipped };
}
