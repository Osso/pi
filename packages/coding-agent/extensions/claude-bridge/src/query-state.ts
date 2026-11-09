// Query state: QueryContext class.
//
// All per-query and per-turn mutable state lives here. Reentrant queries
// (subagents) each get their own QueryContext instance, managed by index.ts.
// Adding a new field = one property on the class.
//
// Extracted from index.ts so tests can import without activating the extension.

import type { AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { McpResult } from "./extract-tool-results.ts";
import type { PromptStream } from "./prompt-stream.ts";
import type { ShapeTrace } from "./shape-trace.ts";
import {
	type AccountObservation,
	type AccountState,
	mergeAccountStates,
	nextAccountProfile,
} from "./account-profiles.ts";

export const ACCOUNTS_EXHAUSTED = "Claude account profiles exhausted. No eligible account remains.";

function dateAccountDenial(previous: AccountObservation | undefined, at: number): AccountObservation {
	const recoveredAt = previous?.available ? previous.at : previous?.recoveredAt;
	return { at, available: false, ...(recoveredAt === undefined ? {} : { recoveredAt }) };
}

export interface AccountStateStore {
	read(): AccountState | undefined;
	/** Applies `change` to the latest shared state and publishes the result. */
	update(change: (state: AccountState | undefined) => AccountState): void;
}

/**
 * Quota state shared by concurrent provider queries and, through the store, by every bridge
 * process, so a restarted Pi keeps the account that last worked instead of retrying an exhausted
 * one. Times are Unix seconds. A rejection without a reset time stays process-local: persisting
 * it would lock the account out of every future process.
 */
export class AccountProfileManager {
	private rejected = new Map<string, number>();
	private blocked = new Map<string, number>();
	private observations: Record<string, AccountObservation> = {};
	private current: string | undefined;
	private names: readonly string[];
	private store: AccountStateStore | undefined;

	constructor(names: readonly string[], active: string | undefined, store?: AccountStateStore) {
		this.names = names;
		this.store = store;
		const first = nextAccountProfile(names, []);
		this.current = active !== undefined && names.includes(active) ? active : first;
	}

	get selectedProfile(): string | undefined {
		const state = this.store?.read();
		if (state) this.loadSharedState(state);
		return this.current;
	}

	select(now: number): string | undefined {
		return this.withSharedState(() => this.selectLoaded(now));
	}

	reject(name: string, resetsAt: number | undefined, now: number): string | undefined {
		return this.withSharedState(() => {
			if (resetsAt !== undefined && Number.isFinite(resetsAt)) {
				const observation = this.observations[name];
				if (!observation || now >= observation.at) {
					this.rejected.set(name, Math.max(this.rejected.get(name) ?? -Infinity, resetsAt));
					this.observations[name] = dateAccountDenial(observation, now);
				}
			} else {
				this.blocked.set(name, Math.max(this.blocked.get(name) ?? -Infinity, now));
			}
			// A late rejection from an old account must not skip a healthy current account.
			return this.selectLoaded(now);
		});
	}

	/** Apply live capacity proof dated at request start, never over a newer denial. */
	recover(name: string, checkedAt: number): boolean {
		if (!this.names.includes(name) || !Number.isFinite(checkedAt)) return false;
		return this.withSharedState(() => {
			const observation = this.observations[name];
			const datedDenial = observation && !observation.available ? observation.at : -Infinity;
			const localDenial = this.blocked.get(name) ?? -Infinity;
			if (Math.max(datedDenial, localDenial) >= checkedAt) return false;
			this.rejected.delete(name);
			this.blocked.delete(name);
			this.observations[name] = { at: Math.max(observation?.at ?? -Infinity, checkedAt), available: true };
			this.current = name;
			return true;
		});
	}

	/** Runs one decision against the latest shared state and publishes the result. */
	private withSharedState<T>(decide: () => T): T {
		if (!this.store) return decide();
		let result!: T;
		this.store.update((state) => {
			if (state) this.loadSharedState(state);
			result = decide();
			return {
				...(this.current === undefined ? {} : { current: this.current }),
				rejected: Object.fromEntries(this.rejected),
				...(Object.keys(this.observations).length === 0 ? {} : { observations: { ...this.observations } }),
			};
		});
		return result;
	}

	private selectLoaded(now: number): string | undefined {
		for (const [name, resetsAt] of this.rejected) {
			if (resetsAt <= now) this.rejected.delete(name);
		}
		const unavailable = new Set([...this.rejected.keys(), ...this.blocked.keys()]);
		if (this.current !== undefined && !unavailable.has(this.current)) return this.current;
		const next = nextAccountProfile(this.names, unavailable);
		if (next !== undefined) this.current = next;
		return next;
	}

	/** Another process's selection and rejections win over this process's stale view. */
	private loadSharedState(state: AccountState): void {
		const merged = mergeAccountStates(
			{ rejected: Object.fromEntries(this.rejected), observations: this.observations },
			state,
		);
		this.rejected = new Map(Object.entries(merged.rejected).filter(([name]) => this.names.includes(name)));
		this.observations = Object.fromEntries(
			Object.entries(merged.observations ?? {}).filter(([name]) => this.names.includes(name)),
		);
		if (state.current !== undefined && this.names.includes(state.current)) this.current = state.current;
	}
}

export interface PendingToolCall {
	toolName: string;
	resolve: (result: McpResult) => void;
}

export class QueryContext {
	// Query-scoped (fully isolated per query)
	activeQuery: unknown | null = null;
	currentPiStream: AssistantMessageEventStream | null = null;
	latestCursor = 0;
	shapeTrace?: ShapeTrace;
	pendingToolCalls = new Map<string, PendingToolCall>();
	pendingResults = new Map<string, McpResult>();
	/** tool_use ids emitted this turn. Sole purpose is routing a delivered result
	 *  to the owning query when several queries are in flight — pairing a result
	 *  to its call is done by id from Claude's tools/call _meta, not from here. */
	turnToolCallIds: string[] = [];
	/** Streaming-input handle for the active query — how steers reach CC mid-turn. */
	promptStream: PromptStream | null = null;
	/** Last rate-limit rejection seen on this query. Claude Code sends it just before the
	 *  failure it caused, which is the only thing tying the two together. */
	rateLimitRejection: Pick<SDKRateLimitInfo, "rateLimitType" | "resetsAt" | "errorCode"> | null = null;
	/** Identity stays with the query even when a concurrent query advances selection. */
	accountProfile: { name: string; manager: AccountProfileManager } | null = null;
	/** Successful pending-request result; recovery waits for non-cancelled settlement. */
	accountAccepted = false;
	/** Quota failure awaits query settlement so cancellation never rejects an account. */
	quotaFailure: { resetsAt?: number } | null = null;
	/** Highest 5% utilization bucket we notified for, so repeat rate_limit_event spam is suppressed. */
	lastRateLimitWarnStep: number | null = null;
	lastRateLimitWarnThreshold: number | undefined;
	/** pi session this query serves, from SimpleStreamOptions.sessionId at fresh-query
	 *  setup. A bridge process serves several pi sessions at once (subagents run their
	 *  own AgentSessions), and history rewrites must only discard the rewriting
	 *  session's parked queries — this is the match key. Null when the host did not
	 *  supply an id.
	 */
	piSessionId: string | null = null;
	/** pi rewrote the history this query was built from (session_compact,
	 *  session_tree in its own pi session). Set by markRebuildForSession, consumed
	 *  by the tool-result delivery that discards the query. Not session-wide state:
	 *  it dies with the context it belongs to, so it cannot leak into later turns
	 *  the way a module flag does.
	 */
	historyStale = false;
	/** A steer never reached CC. A first query has no session mirror yet, so
	 *  completion must carry this into the mirror it creates. */
	missedSteer = false;
	/** pi's run ended on this query's tool call. Its PostToolBatch hook stops CC there, so the
	 *  next prompt opens a new turn instead of steering into this one. */
	turnEnded = false;
	/** Settles when this query's CLI has finished and its session state is recorded. */
	settled: Promise<unknown> | null = null;

	// Per-turn (reset together)
	turnOutput: AssistantMessage | null = null;
	turnStarted = false;
	turnSawStreamEvent = false;
	turnSawToolCall = false;
	/** API message id from the last message_start, and whether its message_stop has
	 *  arrived. An `assistant` message under a different id while the stream is still
	 *  open is Claude Code's non-streaming fallback for a stalled stream. */
	turnStreamMessageId: string | undefined;
	turnStreamOpen = false;
	/** turnBlocks length at that message_start: where an abandoned attempt's blocks begin. */
	turnStreamBlockStart = 0;

	get turnBlocks(): Array<any> {
		if (!this.turnOutput) throw new Error("turnBlocks accessed before resetTurnState");
		return this.turnOutput.content;
	}

	/** Answer every parked MCP handler with `reason` and forget the turn's queued
	 *  results. Called when the query it belongs to is going away (abort, error,
	 *  normal end). Handlers must be *resolved*, not rejected: an error reply is
	 *  still a reply, and a handler left awaiting a subprocess that is gone keeps
	 *  CC's tools/call open forever, which wedges pi's turn behind it. */
	releasePendingToolCalls(reason: string): void {
		for (const pending of this.pendingToolCalls.values())
			pending.resolve({ content: [{ type: "text", text: reason }] });
		this.pendingToolCalls.clear();
		this.pendingResults.clear();
	}

	resetTurnState(model: Model<any>): void {
		this.shapeTrace?.recordPi("turn_reset", this.turnOutput, this.turnStreamMessageId);
		this.turnOutput = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		this.turnStarted = false;
		this.turnSawStreamEvent = false;
		this.turnSawToolCall = false;
		this.turnStreamMessageId = undefined;
		this.turnStreamOpen = false;
		this.turnStreamBlockStart = 0;
		// turnToolCallIds is NOT reset — it persists across tool-result delivery
		// callbacks within the same assistant message so results can be routed to
		// this query while its handlers are still pending.
	}
}

let _ctx = new QueryContext();

export function ctx(): QueryContext {
	return _ctx;
}

// Test-only: replace the module-level context so test files start clean.
// Not called from production.
export function resetCtx(): void {
	_ctx = new QueryContext();
}
