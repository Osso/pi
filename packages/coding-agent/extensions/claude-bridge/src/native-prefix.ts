// Reusing Claude Code's own session records across a rebuild.
//
// A rebuild rewrites the CC session from pi's history. The prompt cache is keyed
// on the exact request prefix, and CC's records carry content pi never sees: its
// context attachments (`environment`, `date`, `total_tokens_reminder`, mid-turn
// `queued_command` steers, ...), `caller` on tool_use blocks, block-shaped tool
// results. A full reconversion drops all of it, so the rebuilt prompt diverges at
// messages[0] and the next request re-caches the whole conversation
// (diag/AUDIT.md, "a rebuild re-caches the whole conversation").
//
// So a rebuild keeps CC's own records for the longest prefix that still says what
// pi's history says, and converts only what follows. "Says the same" compares the
// conversation, not the bytes: text, tool call ids and names, tool result ids,
// text and error flags, and user text including steers CC queued as attachments.
// CC's context attachments, thinking blocks and tool inputs are not compared —
// they are CC's rendering of that conversation, which is exactly what is kept.
//
// Extracted from index.ts so tests can import it without activating the extension.

import { getAgentDir } from "../../../src/config.ts";
import { Session, serializeRecord, type JsonlRecord, type Message } from "cc-session-io";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { messageContentToText } from "./convert.ts";

type Rec = Record<string, unknown>;
type Block = { type: string; [key: string]: unknown };

/** One API message: an assistant message, or a run of user-side content. */
type Unit = { role: "user" | "assistant"; key: string; hasToolUse: boolean; end: number };

const CONVERSATION_TYPES = new Set(["user", "assistant", "attachment"]);
const SYNTHETIC_MODEL = "<synthetic>";

/**
 * A session file's records up to its first unparseable line. A post-abort rebuild
 * reads a file the killed CC subprocess may have been midway through writing, and
 * everything before a torn last line is still CC's record of the conversation.
 * A missing file has no records.
 */
export function readNativeRecords(jsonlPath: string): JsonlRecord[] {
	let content: string;
	try {
		content = readFileSync(jsonlPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const records: JsonlRecord[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			records.push(JSON.parse(line));
		} catch {
			break;
		}
	}
	return records;
}

/** The conversation's records in the order CC appended them. Not the parentUuid
 *  chain: CC parents each parallel tool result to its own tool_use record, so
 *  walking back from the newest record skips every result but one. */
function conversationRecords(records: readonly JsonlRecord[]): Rec[] {
	return (records as readonly Rec[]).filter(
		(record) => CONVERSATION_TYPES.has(record.type as string) && !record.isSidechain,
	);
}

function blocksOf(content: unknown): Block[] {
	if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
	return Array.isArray(content) ? (content as Block[]) : [];
}

/** Accumulates one user-side unit's comparable content. */
class UserSide {
	private results: [string, string, boolean, number][] = [];
	private texts: string[] = [];
	private images = 0;

	add(content: unknown): void {
		for (const block of blocksOf(content)) {
			if (block.type === "tool_result") {
				const images = blocksOf(block.content).filter((b) => b.type === "image").length;
				this.results.push([
					String(block.tool_use_id),
					messageContentToText(block.content as never),
					Boolean(block.is_error),
					images,
				]);
			} else if (block.type === "text" && block.text) {
				this.texts.push(String(block.text));
			} else if (block.type === "image") {
				this.images++;
			}
		}
	}

	// Results sort by id: CC records each result as it arrives, the conversion
	// in pi's order, and the order carries no meaning for the conversation.
	key(): string {
		const results = [...this.results].sort((a, b) => a[0].localeCompare(b[0]));
		return JSON.stringify({ results, texts: this.texts, images: this.images });
	}
}

function assistantUnit(blocks: Block[], end: number): Unit {
	const parts: unknown[] = [];
	for (const block of blocks) {
		if (block.type === "text" && block.text) parts.push(["text", block.text]);
		else if (block.type === "tool_use") parts.push(["tool_use", block.id, block.name]);
	}
	return { role: "assistant", key: JSON.stringify(parts), hasToolUse: blocks.some((b) => b.type === "tool_use"), end };
}

/** Units in order: each assistant message is one, and consecutive user-side
 *  content merges into one, as the API merges consecutive user messages. */
class UnitBuilder {
	readonly units: Unit[] = [];
	private side: UserSide | null = null;

	/** `continues`: the blocks extend the previous assistant unit, which this replaces. */
	assistant(blocks: Block[], end: number, continues = false): void {
		this.side = null;
		this.place(assistantUnit(blocks, end), continues);
	}

	user(content: unknown, end: number): void {
		const continues = this.side !== null;
		this.side ??= new UserSide();
		this.side.add(content);
		this.place({ role: "user", key: this.side.key(), hasToolUse: false, end }, continues);
	}

	/** A record that says nothing comparable joins the current unit as it is. */
	extend(end: number): void {
		const last = this.units[this.units.length - 1];
		if (last) last.end = end;
	}

	private place(unit: Unit, replacesLast: boolean): void {
		if (replacesLast) this.units[this.units.length - 1] = unit;
		else this.units.push(unit);
	}
}

/** The converted messages as units; `end` indexes the unit's last message. */
function messageUnits(messages: readonly Message[]): Unit[] {
	const builder = new UnitBuilder();
	messages.forEach((message, index) => {
		if (message.role === "assistant") builder.assistant(blocksOf(message.content), index);
		else builder.user(message.content, index);
	});
	return builder.units;
}

/** What a user-side record says: a message's content, or a steer CC queued
 *  mid-turn as an attachment. CC's context attachments and meta messages are its
 *  own rendering, kept but not compared. */
function userSideContent(record: Rec): unknown {
	if (record.type === "attachment") {
		const attachment = record.attachment as Rec | undefined;
		return attachment?.type === "queued_command" ? attachment.prompt : undefined;
	}
	return record.isMeta ? undefined : (record.message as Rec | undefined)?.content;
}

/** CC's records as units; `end` indexes the unit's last record. One assistant
 *  message spans several records sharing a `message.id`. An assistant message
 *  CC wrote itself (`model: "<synthetic>"`, e.g. the "No response requested."
 *  after a turn the bridge ended on a tool) never reached pi, so it is kept but
 *  not compared. */
function recordUnits(records: readonly Rec[]): Unit[] {
	const builder = new UnitBuilder();
	let assistant: { id: unknown; blocks: Block[] } | null = null;
	records.forEach((record, index) => {
		if (record.type !== "assistant") {
			assistant = null;
			builder.user(userSideContent(record), index);
			return;
		}
		const message = record.message as Rec;
		if (message.model === SYNTHETIC_MODEL) {
			builder.extend(index);
			return;
		}
		const current =
			assistant !== null && assistant.id === message.id ? assistant : { id: message.id, blocks: [] as Block[] };
		const continues = current === assistant;
		current.blocks.push(...blocksOf(message.content));
		assistant = current;
		builder.assistant(current.blocks, index, continues);
	});
	return builder.units;
}

/**
 * CC's records for the longest prefix of `messages` they still match, and how
 * many of `messages` that prefix covers. The prefix ends on a settled boundary —
 * never on an assistant message whose tool calls are answered in the converted
 * remainder, since importing that remainder alone would drop the orphaned results.
 */
export function nativePrefix(
	records: readonly JsonlRecord[],
	messages: readonly Message[],
): { records: JsonlRecord[]; covered: number } {
	const conversation = conversationRecords(records);
	const native = recordUnits(conversation);
	const converted = messageUnits(messages);
	let matched = 0;
	while (
		matched < native.length &&
		matched < converted.length &&
		native[matched].role === converted[matched].role &&
		native[matched].key === converted[matched].key
	)
		matched++;
	while (matched > 0 && converted[matched - 1].hasToolUse) matched--;
	if (matched === 0) return { records: [], covered: 0 };
	return {
		records: conversation.slice(0, native[matched - 1].end + 1) as JsonlRecord[],
		covered: converted[matched - 1].end + 1,
	};
}

/**
 * `empty`'s file written with CC's `records`, returned as the session to import
 * the remainder into. Records keep their uuids — the remainder chains from the
 * last one — and take `empty`'s sessionId.
 */
export function seedSession(empty: Session, records: readonly JsonlRecord[], model?: string): Session {
	const own = records.map((record) => ({ ...record, sessionId: empty.sessionId }) as JsonlRecord);
	mkdirSync(dirname(empty.jsonlPath), { recursive: true });
	writeFileSync(empty.jsonlPath, own.map((record) => serializeRecord(record) + "\n").join(""), "utf-8");
	return new Session({
		sessionId: empty.sessionId,
		projectPath: empty.projectPath,
		jsonlPath: empty.jsonlPath,
		cwd: empty.projectPath,
		model,
		records: own,
		fileExists: true,
	});
}

// The CC session a pi session last ran on, kept on disk. The in-memory mirror
// does not survive a restart, a /reload or a session switch, and without it the
// next turn has no CC file to take records from. Only a hint: nativePrefix keeps
// nothing that disagrees with pi's history.

function recordPath(piSessionId: string): string {
	return join(getAgentDir(), "claude-bridge-sessions", `${encodeURIComponent(piSessionId)}.json`);
}

export function recordNativeSession(piSessionId: string, sessionId: string, cwd: string): void {
	const path = recordPath(piSessionId);
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify({ sessionId, cwd }), "utf-8");
	renameSync(temp, path);
}

/** The recorded CC session for `piSessionId` in `cwd`, if any. A session recorded
 *  under another cwd lives in another project directory. */
export function recordedNativeSession(piSessionId: string, cwd: string): string | undefined {
	let content: string;
	try {
		content = readFileSync(recordPath(piSessionId), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const record = JSON.parse(content) as { sessionId?: unknown; cwd?: unknown };
	return record.cwd === cwd && typeof record.sessionId === "string" ? record.sessionId : undefined;
}
