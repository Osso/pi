import type { Context } from "@earendil-works/pi-ai";
import {
	createSession,
	deleteSession,
	getSessionPath,
	type ImportAttachment,
	type JsonlRecord,
	type Message,
	normalizeProjectPath,
	repairToolPairing,
	type Session,
} from "cc-session-io";
import { realpathSync, statSync } from "fs";
import type { CompactionEntry } from "../../../src/core/session-manager.ts";
import { collectCarriedAttachments, placeCarriedAttachments } from "./attachments.ts";
import { convertPiMessages } from "./convert.ts";
import { DEBUG, debug, diagDump } from "./diagnostics.ts";
import { extractAllToolResults as _extractAllToolResults, type McpResult } from "./extract-tool-results.ts";
import { turnStart } from "./isolated-summary.ts";
import { debugLogPath } from "./log-paths.ts";
import {
	nativePrefix,
	readNativeRecords,
	recordedNativeSession,
	recordNativeSession,
	seedSession,
} from "./native-prefix.ts";
import { activeQueryContexts } from "./query-state.ts";
import { verifyWrittenSession as _verifyWrittenSession } from "./session-verify.ts";

import { piUI } from "./ui-state.ts";

// --- Session persistence ---

export interface SessionState {
	sessionId: string;
	cursor: number;
	cwd: string;
	// Force the next syncSharedSession call down the REBUILD path. Set when
	// pi has mutated its messages array out from under us (compact, tree
	// navigation) or after an abort left the JSONL in an indeterminate state.
	// REBUILD wipes and rewrites the file to match pi's current history.
	needsRebuild?: boolean;
	// Set ONLY where we have just killed a CC subprocess: an abort, or a query
	// discarded because pi rewrote the history under it. The killed subprocess
	// may still be flushing a late "[Request interrupted by user]" record to the
	// session JSONL. Reusing the same sessionId/path would race that orphan write
	// into our fresh file and break CC's parent-uuid chain on the next resume.
	// When this flag is set, REBUILD takes a fresh UUID and skips deleteSession
	// so the orphan writes land on a dead inode. A compact or tree navigation
	// with no query in flight does NOT set this — there's no concurrent CC writer
	// then, so in-place rebuild (preserve UUID, deleteSession + createSession) is safe.
	forceRotate?: boolean;
}

/**
 * Claude Code's records of the session about to be replaced: the prefix a rebuild
 * keeps, and the `@file` expansions it carries past that prefix.
 *
 * Must be called before `deleteSession`, which wipes the file they live in —
 * reading after it yields nothing, with no error to notice.
 */
function readPreviousSession(sessionId: string, cwd: string): JsonlRecord[] {
	try {
		return readNativeRecords(getSessionPath(sessionId, normalizeProjectPath(cwd), process.env.CLAUDE_CONFIG_DIR));
	} catch (error) {
		// Throwing here would turn an unreadable old file into a failed turn;
		// rebuilding from pi's history alone is what happened before this existed,
		// so the failure mode is bounded by the status quo.
		debug(`WARNING: could not read session ${sessionId.slice(0, 8)}:`, error);
		return [];
	}
}

/** The session key a pi session's provider calls address. Unattributed calls
 *  (a host that omits options.sessionId)
 *  share the "(none)" bucket: they cannot be told apart, so they share the
 *  pre-existing single-slot semantics. */
function sessionKey(piSessionId: string | null | undefined): string {
	return piSessionId ?? "(none)";
}

/** Mirror of the CC conversation one pi session's turns are running on. One
 *  entry per pi session: a bridge process serves several sessions at once
 *  (pi-subagents children run their own AgentSessions), and a single shared
 *  slot forced them to fight over it — a length-matching foreign sync could
 *  REUSE or rebuild another session's CC file, and the completion capture was
 *  last-writer-wins (a foreground child in the parent's first turn permanently
 *  reassigned the parent's conversation). Keyed lookup removes the fight: each
 *  session's reads, writes and teardown marks touch only its own mirror. */
export const sharedSessions = new Map<string, SessionState>();

/** The mirror for `piSessionId`, or null when this session has none yet. */
export function sessionStateFor(piSessionId: string | null | undefined): SessionState | null {
	return sharedSessions.get(sessionKey(piSessionId)) ?? null;
}

/** Replace (or plant) the mirror for `piSessionId`. */
export function setSessionStateFor(piSessionId: string | null | undefined, state: SessionState | null): void {
	if (state === null) sharedSessions.delete(sessionKey(piSessionId));
	else sharedSessions.set(sessionKey(piSessionId), state);
	if (piSessionId && state && recordedSessions.get(piSessionId) !== state.sessionId) {
		try {
			recordNativeSession(piSessionId, state.sessionId, state.cwd);
			recordedSessions.set(piSessionId, state.sessionId);
		} catch (error) {
			// Costs the next restart its cache, not this turn.
			debug(
				`WARNING: could not record session ${state.sessionId.slice(0, 8)} for pi session ${piSessionId}:`,
				error,
			);
		}
	}
}

/** The CC session each pi session was last recorded on, to skip rewriting it. */
const recordedSessions = new Map<string, string>();

/** The CC session a pi session ran on before this process lost its mirror. */
function recordedSessionFor(piSessionId: string | null | undefined, cwd: string): string | undefined {
	if (!piSessionId) return undefined;
	try {
		return recordedNativeSession(piSessionId, cwd);
	} catch (error) {
		debug(`WARNING: could not read the recorded session for pi session ${piSessionId}:`, error);
		return undefined;
	}
}

// pi replaced one of its sessions' history (compact, tree) rather than appending
// to it. Read on the tool-result path — the one provider call that never reaches
// syncSharedSession — so a query parked at a tool boundary is discarded rather
// than resumed (issue #101). Keyed by pi session id, not process-global: a bridge
// process serves several pi sessions at once (subagents run their own
// AgentSessions and can compact mid-run while the parent is parked), and
// marking across that boundary kills healthy queries (or, worse, rebuilds the
// parent around a compaction that never touched it).
//
// Holds real pi session ids only, never the "(none)" key: no production caller
// marks with null (the rewrite events attribute via ctx.sessionManager), and
// every reader guards on a non-null piSessionId — so a "(none)" entry could
// never be matched or consumed, only leaked.
export const historyRewrittenBySession = new Set<string>();

/** Handlers that arm rewrite staleness, one per module instance. Worktree-
 *  spawned subagents can load this module fresh (pi's loader cache is keyed on
 *  cwd, and a worktree cwd clears it), while the serving instance — whose
 *  streamSimple the pi sessions actually call — is whoever registered first.
 *  A fresh instance must forward its session's rewrites to the serving one.
 *  Symbol.for: one registry per process, like SHARED_CAPTURES_KEY below. */
const MARK_REBUILD_HOOKS_KEY = Symbol.for("claude-bridge:markRebuildHooks");
type MarkRebuildHook = (piSession: string | null, event: string) => void;
const markRebuildHooks: Set<MarkRebuildHook> =
	((globalThis as Record<symbol, unknown>)[MARK_REBUILD_HOOKS_KEY] as Set<MarkRebuildHook> | undefined) ?? new Set();
(globalThis as Record<symbol, unknown>)[MARK_REBUILD_HOOKS_KEY] = markRebuildHooks;

/** pi mutated its messages array out from under us: force the next
 *  syncSharedSession down REBUILD, and arm the discard above. `piSession`
 *  is never null from an event handler (each pi session has its own runner).
 *  The "(none)" key still covers the mirror for a hypothetical direct caller
 *  with no session id, so such a rewrite forces the REBUILD side; the discard
 *  set holds real ids only — see the comment on historyRewrittenBySession. */
export function markRebuildForSession(piSession: string | null, event: string): void {
	// The rewriting session's own mirror: the rewrite changed the history it was
	// built from, so its next sync must REBUILD rather than REUSE. Every other
	// session's mirror stays untouched — its conversation was never rewritten.
	const key = sessionKey(piSession);
	const state = sharedSessions.get(key);
	if (!state) {
		debug(`${event}: history rewritten, no session to mark yet`);
	} else {
		sharedSessions.set(key, { ...state, needsRebuild: true });
		debug(`${event}: marking needsRebuild on session ${state.sessionId.slice(0, 8)}`);
	}
	// Arming parked contexts cannot wait for delivery: the entry checks
	// `resultCtx.historyStale`, and a rewrite usually lands *while* the query is
	// parked (compaction runs inside pi's turn loop, not between provider calls).
	if (piSession) historyRewrittenBySession.add(piSession);
	armStaleContexts();
}

/** Copy each armed session's mark onto the parked queries built from it. */
export function armStaleContexts(): void {
	for (const c of activeQueryContexts) {
		if (c.piSessionId && historyRewrittenBySession.has(c.piSessionId)) c.historyStale = true;
	}
}

// This instance enlists. Session ids reaching any hook equal options.sessionId
// on the serving instance's provider calls, so forwarding is safe: only the
// owning instance's contexts and SessionState match the key.
markRebuildHooks.add(markRebuildForSession);

/** Event handlers call this: it fans the rewrite out to every module instance
 *  in the process, of which exactly one is serving provider traffic for any
 *  given pi session. */
export function sponsorMarkRebuildForSession(piSession: string | null, event: string): void {
	for (const hook of markRebuildHooks) hook(piSession, event);
}

// Convert pi messages to Anthropic API format for session import.
// Lossy: only text, thinking and toolCall blocks survive, and thinking only when
// Claude Code itself minted the signature. An assistant message whose blocks all
// filter out keeps its slot with a placeholder, since dropping it can create a
// tool_result with no preceding tool_use. A turn aborted before anything streamed
// is dropped instead — it never had content, and inventing one diverges from the
// prefix Claude Code cached.
//
// `native` is Claude Code's own record of the conversation being replaced. The
// longest prefix of it that still matches pi's history is kept verbatim and only
// the rest converted (native-prefix.ts), so the rebuilt prompt starts with what
// CC last sent. Returns the session the history was written to: `session`, or a
// replacement at the same path seeded with that prefix.
function convertAndImportMessages(
	session: Session,
	messages: Context["messages"],
	customToolNameToSdk: Map<string, string>,
	native: readonly JsonlRecord[] = [],
	modelId?: string,
): Session {
	const { anthropicMessages, sanitizedIds, dropped } = convertPiMessages(messages, customToolNameToSdk);

	debug(`convertAndImportMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs`);
	debug(
		`convertAndImportMessages: imported roles:`,
		anthropicMessages
			.map((m, i) => {
				const c = m.content;
				if (typeof c === "string") return `[${i}]${m.role}:text`;
				if (Array.isArray(c)) return `[${i}]${m.role}:${c.map((b) => b.type).join("+")}`;
				return `[${i}]${m.role}:?`;
			})
			.join(" "),
	);
	// The roles line above shows only what survived, so a stripped block is
	// indistinguishable there from one that never existed. Name the losses.
	const droppedParts = [
		dropped.thinking ? `${dropped.thinking} thinking (${[...dropped.providers].sort().join(", ")})` : "",
		dropped.abortedTurns ? `${dropped.abortedTurns} aborted turn(s)` : "",
		...[...dropped.other].map(([type, n]) => `${n} ${type}`),
	].filter(Boolean);
	if (droppedParts.length > 0) {
		debug(`convertAndImportMessages: dropped ${droppedParts.join(", ")}`);
	}
	if (sanitizedIds.size > 0) {
		debug(
			`convertAndImportMessages: sanitized ${sanitizedIds.size} tool IDs:`,
			[...sanitizedIds.entries()].map(([orig, clean]) => (orig === clean ? orig : `${orig}→${clean}`)).join(", "),
		);
	}
	// Pre-repair for debug logging; importMessages also repairs internally (idempotent).
	const repaired = repairToolPairing(anthropicMessages);
	if (repaired.length !== anthropicMessages.length) {
		debug(`convertAndImportMessages: repairToolPairing ${anthropicMessages.length} → ${repaired.length} msgs`);
	}
	const prefix = nativePrefix(native, repaired);
	if (native.length) {
		debug(
			`convertAndImportMessages: kept ${prefix.records.length} of ${native.length} CC records, covering ${prefix.covered}/${repaired.length} msgs`,
		);
	}
	const target = prefix.records.length ? seedSession(session, prefix.records, modelId) : session;
	const tail = repaired.slice(prefix.covered);
	const attachments = tailAttachments(native, prefix.records, repaired, prefix.covered);
	if (tail.length) {
		target.importMessages(tail, attachments.length ? { attachments } : undefined);
	}
	return target;
}

/** CC's `@file` expansions for the converted tail, `repaired.slice(covered)`.
 *  Placement runs against the repaired array because that is the index space
 *  importMessages reads. Attachments are links in CC's uuid chain, so they have
 *  to be written in order with the messages, not appended afterwards. Those
 *  inside the kept prefix are already among CC's records. */
function tailAttachments(
	native: readonly JsonlRecord[],
	kept: readonly JsonlRecord[],
	repaired: readonly Message[],
	covered: number,
): ImportAttachment[] {
	const keptAttachments = new Set(
		kept.map((record) => (record as { attachment?: unknown }).attachment).filter(Boolean),
	);
	const carried = collectCarriedAttachments(native).filter((item) => !keptAttachments.has(item.attachment));
	if (!carried.length) return [];
	const placed = placeCarriedAttachments(carried, repaired as unknown as { role: string; content: unknown }[]);
	if (placed.skipped.length) {
		debug(
			`convertAndImportMessages: dropped ${placed.skipped.length} carried attachment(s): ${placed.skipped.join("; ")}`,
		);
	}
	const attachments = placed.attachments
		.filter((a) => a.afterIndex >= covered)
		.map((a) => ({ ...a, afterIndex: a.afterIndex - covered }));
	if (attachments.length) {
		debug(`convertAndImportMessages: carrying ${attachments.length} attachment(s) across the rebuild`);
	}
	return attachments;
}

// Pi doesn't pass tool results directly — it appends them to the context and calls
// the provider again. Thin wrapper over extract-tool-results.js that adds per-turn
// debug logging at the extraction boundary.
export function extractAllToolResults(context: Context): McpResult[] {
	const { results, stopIdx } = _extractAllToolResults(
		context.messages as unknown as Array<{ role: string; [key: string]: unknown }>,
	);
	debug(
		`extractAllToolResults: ${results.length} results from ${context.messages.length} msgs, stopped at index ${stopIdx}`,
	);
	debug(`extractAllToolResults: all msg roles:`, context.messages.map((m, i) => `[${i}]${m.role}`).join(" "));
	for (const [r, result] of results.entries()) {
		debug(
			`extractAllToolResults: result[${r}] id=${result.toolCallId}${result.isError ? " ERROR" : ""} preview:`,
			JSON.stringify(result.content).slice(0, 150),
		);
	}
	return results;
}

/** Name a failure as a rate limit when a rejection preceded it.
 *
 *  pi has no typed rate-limit error — `stopReason` is only ever `"error"` and the sole carrier
 *  is `errorMessage` — so everything that reacts to a rate limit pattern-matches that string:
 *  pi-subagents gates `fallbackModels` on its own pattern list, and key-rotating extensions use
 *  their own. Claude Code words a subscription limit as "You're out of extra usage · resets
 *  6:30pm", which matches none of them, so an exhausted quota reads as a fatal error and the
 *  fallback chain never runs (issue #58).
 *
 *  Leading with "Claude rate limit" rather than appending keeps the phrase in any truncated
 *  render, and avoids the `<tool> failed (exit N):` shape that pi-subagents treats as a tool
 *  failure and refuses to retry. */

export function reinjectPriorCompactionFileOps(
	branchEntries: Array<{ type: string; details?: unknown }>,
	preparation: { fileOps: { read: Set<string>; modified: Set<string> } },
): void {
	const prior = [...branchEntries].reverse().find((entry): entry is CompactionEntry => entry.type === "compaction");
	const details = prior?.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
	if (!Array.isArray(details?.readFiles) || !Array.isArray(details?.modifiedFiles)) return;
	for (const file of details.readFiles) preparation.fileOps.read.add(String(file));
	for (const file of details.modifiedFiles) preparation.fileOps.modified.add(String(file));
	debug(
		`compact takeover: re-injected prior file ops read=${details.readFiles.length} modified=${details.modifiedFiles.length}`,
	);
}

interface SyncResult {
	sessionId: string | null;
	preserveSharedSession?: boolean;
}

/**
 * Ensure the shared session has all messages up to (but not including) the last user message.
 * Returns session ID to resume from, or null if no resume needed.
 */
// Read the session file we just wrote and sanity-check it. Warns instead of
// throwing — CC may be more tolerant than our checks, so a false positive
// shouldn't block the user. Pure logic is in session-verify.js; this wrapper
// fans each warning out to debug log + piUI notify + diagDump.
function verifyWrittenSession(
	jsonlPath: string,
	expectedSessionId: string,
	expectedRecordCount: number,
	cwd: string,
): void {
	const warnings = _verifyWrittenSession(jsonlPath, expectedSessionId, expectedRecordCount);
	for (const msg of warnings) {
		debug(`WARNING session verify: ${msg}`);
		piUI?.notify(
			`Session file issue: ${msg}\n` +
				`cwd=${cwd} realpath=${safeRealpath(cwd)} CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"}\n` +
				(DEBUG ? `Debug log: ${debugLogPath()}` : "Rerun with CLAUDE_BRIDGE_DEBUG=1 to capture a debug log."),
			"warning",
		);
		diagDump("session_verify_fail", {
			msg,
			jsonlPath,
			cwd,
			realpath: safeRealpath(cwd),
			claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
		});
	}
}

function safeRealpath(p: string): string {
	try {
		return realpathSync(p);
	} catch (e) {
		return `<failed: ${(e as Error).message}>`;
	}
}

// Diagnostic snapshot of where a session file was just written. Catches the
// class of bugs where pi writes to ~/.claude/projects/<X> but CC SDK reads
// from ~/.claude/projects/<Y> (symlinks, CLAUDE_CONFIG_DIR, hash mismatch).
function debugSessionPaths(label: string, cwd: string, jsonlPath: string): void {
	const realCwd = safeRealpath(cwd);
	let fileSize: number | null = null;
	let fileExists = false;
	try {
		const st = statSync(jsonlPath);
		fileExists = true;
		fileSize = st.size;
	} catch {
		/* file may not exist yet */
	}
	debug(`${label}: cwd=${cwd}`);
	if (realCwd !== cwd)
		debug(`${label}: realpath(cwd)=${realCwd} (DIFFERS — symlink-resolved path is what CC SDK uses)`);
	debug(`${label}: jsonlPath=${jsonlPath}`);
	debug(`${label}: fileExists=${fileExists}${fileSize != null ? ` size=${fileSize}` : ""}`);
	debug(
		`${label}: env.CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"} HOME=${process.env.HOME ?? "(unset)"}`,
	);
}

// Two semantic paths:
//   REUSE — pi's history is in sync with the existing sharedSession (or drifted
//     only by the trailing final-assistant message that pi appends after
//     streamSimple returns, which CC's own persisted session already has).
//     Returns the existing sessionId. Keeps CC's prompt cache warm.
//   REBUILD — no session yet, or pi's history has diverged (non-trailing
//     missed messages, e.g. another provider took a turn). Wipes the existing
//     session file (if any) and writes a fresh one containing all prior
//     messages, reusing the same sessionId across rebuilds so UUIDs stay
//     stable for the lifetime of pi's session. The part of the old file that
//     still matches pi's history is kept as CC wrote it (native-prefix.ts), so
//     the rebuilt prompt reads back from the prompt cache.
//
// Why a full rebuild rather than patching:
//   Injecting deltas into an existing session creates a branch that CC's
//   --resume doesn't follow (documented attempt prior to this). A complete
//   overwrite at the same path is simpler and correct.
//
// Why reuse the sessionId across rebuilds:
//   CC re-reads the JSONL on every --resume call — no in-process UUID
//   caching. This holds even when
//   CC had appended its own tool_use/tool_result records between
//   rebuilds. Preserving the UUID means stable log correlation across
//   provider switches and no orphaned session files.
//
// Log strings still say "Case 1/2/3/4" so log searches keep the same anchors.
/** The "(none)" bucket's mirror when a shorter context is an unrelated short caller, not a rewrite. */
function findShorterUnownedMirror(
	sharedSession: SessionState | null,
	priorCount: number,
	piSessionId: string | null | undefined,
): SessionState | undefined {
	if (piSessionId != null || !sharedSession || sharedSession.needsRebuild) return undefined;
	return priorCount < sharedSession.cursor ? sharedSession : undefined;
}

export function deleteEphemeralSession(
	capturedSessionId: string | undefined,
	sharedSessionId: string | undefined,
	cwd: string,
): void {
	if (!capturedSessionId || capturedSessionId === sharedSessionId) return;
	deleteSession(capturedSessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
	debug(`provider: query done, deleted ephemeral session ${capturedSessionId.slice(0, 8)} to preserve shared session`);
}

export function syncSharedSession(
	messages: Context["messages"],
	cwd: string,
	customToolNameToSdk: Map<string, string>,
	modelId?: string,
	piSessionId?: string | null,
): SyncResult {
	// System messages are pi's transcript representation of prompt and tool state, not
	// conversation history — they are never imported into a CC session, so exclude them from
	// the history space (priorMessages, cursor, missed) everywhere below (issue #106).
	// The mirror this sync coordinates belongs to the syncing pi session alone:
	// every read and write below addresses sessionStateFor(piSessionId), so a
	// foreign session's shape-matching context can never REUSE or rebuild another
	// session's CC file.
	const sharedSession = sessionStateFor(piSessionId);
	const history = messages;
	const priorMessages = history.slice(0, turnStart(history)); // everything before the current user turn

	// REUSE path
	//
	// Guard on priorMessages.length >= cursor: a shorter incoming context cannot
	// be a continuation of the cached session. This is the general invariant for
	// pi-side history rewrites such as /compact and session_tree: without it,
	// missed = [].slice(cursor) can falsely hit REUSE and resume an unrelated
	// longer CC session. See issue #25.
	if (sharedSession && !sharedSession.needsRebuild && priorMessages.length >= sharedSession.cursor) {
		const missed = priorMessages.slice(sharedSession.cursor);
		const trailingAssistantOnly = missed.length === 1 && (missed[0] as { role?: string }).role === "assistant";
		if (missed.length === 0 || trailingAssistantOnly) {
			if (trailingAssistantOnly) {
				setSessionStateFor(piSessionId, { ...sharedSession, cursor: priorMessages.length, cwd });
				debug(
					`Case 3: advanced cursor past trailing assistant, resuming session ${sharedSession.sessionId.slice(0, 8)}, cursor=${priorMessages.length}`,
				);
			} else {
				debug(`Case 3: resuming session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`);
			}
			debug(`syncResult: path=reuse sessionId=${sharedSession.sessionId} cursor=${sharedSession?.cursor}`);
			return { sessionId: sharedSession.sessionId };
		}
	}
	// The unowned "(none)" bucket can serve short reentrant contexts
	// unrelated to its longer conversation. Start clean and preserve that bucket;
	// completion deletes the ephemeral session (see preserveSharedSession).
	// A session-owned mirror instead rebuilds below from pi's authoritative history:
	// runtime-only messages such as the end_turn nudge can disappear without a
	// history-rewrite event. Neither case may REUSE the longer CC history (issue #25).
	// Isolated summaries never reach this function.
	const unownedMirror = findShorterUnownedMirror(sharedSession, priorMessages.length, piSessionId);
	if (unownedMirror) {
		debug(
			`Case 1 synthetic: clean start for shorter context, preserving shared session ${unownedMirror.sessionId.slice(0, 8)}, cursor=${unownedMirror.cursor}`,
		);
		debug(
			`syncResult: path=clean-start preserve-shared sessionId=${unownedMirror.sessionId} cursor=${unownedMirror.cursor}`,
		);
		return { sessionId: null, preserveSharedSession: true };
	}

	// REBUILD path
	if (priorMessages.length === 0) {
		debug(`Case 1: clean start, ${history.length} total messages`);
		debug(`syncResult: path=clean-start`);
		return { sessionId: null };
	}
	const previousSessionId = sharedSession?.sessionId;
	const previousCursor = sharedSession?.cursor ?? 0;
	// preserveId: rebuild in place (deleteSession + createSession with the
	// existing UUID), so prompt-cache UUIDs stay stable for log correlation
	// and for any tools that key off them. Skipped when there's a concurrent
	// writer we shouldn't race (forceRotate).
	const preserveId = previousSessionId !== undefined && !sharedSession?.forceRotate;
	// CC's own record of this conversation: the mirror's file or, when this process
	// has no mirror (restart, /reload, session switch), the file the pi session last
	// ran on. The recorded one is never rewritten in place — its last writer may be
	// an earlier process's subprocess — so it only seeds a fresh session id.
	const nativeSessionId = previousSessionId ?? recordedSessionFor(piSessionId, cwd);
	// Before deleteSession — it wipes the file these live in.
	const native = nativeSessionId !== undefined ? readPreviousSession(nativeSessionId, cwd) : [];
	if (preserveId && previousSessionId !== undefined) {
		// Wipe prior jsonl + companion dir (no-op if nothing to wipe).
		deleteSession(previousSessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
	}
	const session = createSession({
		projectPath: cwd,
		claudeDir: process.env.CLAUDE_CONFIG_DIR,
		...(preserveId ? { sessionId: previousSessionId } : {}),
		...(modelId ? { model: modelId } : {}),
	});
	const written = convertAndImportMessages(session, priorMessages, customToolNameToSdk, native, modelId);
	written.save();
	// records, not messages: `messages` filters out the attachment records that
	// carrying an `@file` expansion across a rebuild writes into the same file.
	verifyWrittenSession(written.jsonlPath, written.sessionId, written.records.length, cwd);
	setSessionStateFor(piSessionId, {
		sessionId: session.sessionId,
		cursor: priorMessages.length,
		cwd,
	});
	if (previousSessionId === undefined) {
		const seededFrom =
			nativeSessionId !== undefined ? ` seeded from recorded session ${nativeSessionId.slice(0, 8)}` : "";
		debug(
			`Case 2: first turn with ${priorMessages.length} prior messages → session ${session.sessionId.slice(0, 8)}${seededFrom}, ${written.records.length} records`,
		);
	} else if (preserveId) {
		const missedCount = priorMessages.length - previousCursor;
		debug(
			`Case 4: ${missedCount} missed messages, ${priorMessages.length} total → rewrote session ${session.sessionId.slice(0, 8)} (same id), ${written.records.length} records`,
		);
	} else {
		debug(
			`Case 4 post-abort: ${priorMessages.length} total → new session ${session.sessionId.slice(0, 8)} (was ${previousSessionId.slice(0, 8)}, rotated to avoid race with orphan writer), ${written.records.length} records`,
		);
	}
	debugSessionPaths(`${session.sessionId.slice(0, 8)}`, cwd, session.jsonlPath);
	debug(
		`syncResult: path=rebuild sessionId=${session.sessionId} priors=${priorMessages.length} ${previousSessionId === undefined ? "first" : preserveId ? "preserved" : "rotated-post-abort"}`,
	);
	return { sessionId: session.sessionId };
}
