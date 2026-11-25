import { query, type SDKMessage, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam } from "@anthropic-ai/sdk/resources";
import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type ImageContent,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type UserMessage,
} from "@earendil-works/pi-ai";
import {
	classifyAccountFailure,
	errorMessage,
	fetchAccountRetryProfiles,
	logServedContextWindow,
	prepareProviderAccount,
} from "./account-runtime.ts";
import { type AuthTraceProfile, recordAuthFailure, recordCredentialTrace } from "./auth-trace.ts";
import { resolveClaudeCodeExecutable } from "./bundled-runtime.ts";
import { loadConfig } from "./config.ts";
import { messageContentToText } from "./convert.ts";
import { debug, makeCliDebugOptions } from "./diagnostics.ts";
import { claudeCodeModelId, type LongContextSettings } from "./models.ts";
import { ACCOUNTS_EXHAUSTED, newAssistantOutput, type QueryContext } from "./query-state.ts";

// Applied to every Claude Code subprocess the bridge spawns — provider and the
// compact summary. One place, so a guard is added once rather than twice, and so
// a missing one is visible.
//
// - ENABLE_CLAUDEAI_MCP_SERVERS=0: keep the user's claude.ai-connected MCP servers
//   out of a pi session, which serves its own tools.
// - DISABLE_AUTO_COMPACT=1: pi owns compaction; CC compacting its own copy would
//   diverge from pi's history, which is the source of truth for every rebuild.
export const CC_CHILD_ENV = {
	ENABLE_CLAUDEAI_MCP_SERVERS: "0",
	DISABLE_AUTO_COMPACT: "1",
} as const;

let isolatedQueryImpl: typeof query = query;
export let longContextSettings: LongContextSettings = { plan: "pro", longContextExtraUsage: false };

export function setIsolatedQueryImpl(fn: typeof query | null): void {
	isolatedQueryImpl = fn ?? query;
}

export function setLongContextSettings(settings: LongContextSettings): void {
	longContextSettings = settings;
}

/** Index of the first message of the current user turn — the trailing run of
 *  user messages that has not been written into the Claude Code session yet.
 *  Equals messages.length when the last message is not a user message.
 *
 *  Single source of truth for the history/prompt split: everything before this
 *  index is replayed as session history, everything from it onward becomes the
 *  prompt. Deriving both halves from one index is what keeps a message from
 *  landing in both — an extension appending a display-only user message after
 *  the real one (see issue #34) makes the turn longer than one message. */
export function turnStart(messages: Context["messages"]): number {
	let i = messages.length;
	while (i > 0 && messages[i - 1]?.role === "user") i--;
	return i;
}

/** Extract the current user turn as a prompt string. Returns null if the last message is not a user message. */
export function extractUserPrompt(messages: Context["messages"]): string | null {
	const turn = messages.slice(turnStart(messages)) as UserMessage[];
	if (turn.length === 0) return null;
	// Drop empties before joining so an all-empty turn still yields "" and trips
	// the caller's empty-prompt guard rather than sending bare newlines.
	return turn
		.map((m) => (typeof m.content === "string" ? m.content : messageContentToText(m.content)))
		.filter((text) => text)
		.join("\n");
}

/** Extract the current user turn as ContentBlockParam[] (preserving images).
 *  Returns null if no images — caller should fall back to string prompt. */
export function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const turn = messages.slice(turnStart(messages)) as UserMessage[];
	if (turn.length === 0) return null;

	let hasImage = false;
	const blocks: ContentBlockParam[] = [];
	for (const message of turn) {
		const content: (TextContent | ImageContent)[] =
			typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
		// Off-type content violates UserMessage's contract, so fail rather than
		// degrade — but name the shape, since the cause is almost always another
		// extension appending a malformed message, not this file.
		if (!Array.isArray(content)) {
			throw new Error(
				`extractUserPromptBlocks: user message content must be a string or block array, got ${typeof content} — likely a malformed message from another extension`,
			);
		}
		for (const block of content) {
			if (block.type === "text" && block.text) {
				blocks.push({ type: "text", text: block.text });
			} else if (block.type === "image") {
				// Guard before logging: data-less image blocks do occur, and reading
				// .length off the missing field in the debug template would throw
				// before this check ever runs (template args evaluate unconditionally).
				if (!block.data || !block.mimeType) {
					debug(`image block missing data or mimeType, skipping: keys=${Object.keys(block).join(",")}`);
					continue;
				}
				debug(`image block: mimeType=${block.mimeType}, data length=${block.data.length}`);
				hasImage = true;
				blocks.push({
					type: "image",
					source: {
						type: "base64",
						media_type: block.mimeType as Base64ImageSource["media_type"],
						data: block.data,
					},
				});
			}
		}
	}
	debug(
		`extractUserPromptBlocks: ${turn.length} msgs in turn, ${blocks.length} blocks, types=${blocks.map((b) => b.type).join(",")}`,
	);
	return hasImage ? blocks : null;
}

function extractIsolatedSummaryPrompt(messages: Context["messages"]): string {
	if (messages.length !== 1 || messages[0]?.role !== "user") {
		throw new Error(
			`isolatedStreamFn: expected exactly 1 user message, got ${messages.length} ` +
				`(${messages.map((m) => m.role).join(",")})`,
		);
	}
	const promptText = extractUserPrompt(messages);
	if (!promptText) throw new Error("isolatedStreamFn: summarization prompt is empty");
	return promptText;
}

/** Failure text for an SDK result, or undefined when it succeeded. CC reports API failures
 *  (429 capacity, overload, prompt-too-long) with `is_error` on an otherwise success-shaped
 *  result; the dedicated error subtypes carry `errors` instead. */
export function resultErrorText(message: SDKMessage): string | undefined {
	const result = message as SDKMessage & {
		subtype?: string;
		is_error?: boolean;
		result?: string;
		errors?: unknown;
		error?: unknown;
	};
	if (result.subtype === "success")
		return result.is_error ? result.result || "Claude Code reported an error" : undefined;
	if (Array.isArray(result.errors) && result.errors.length) return result.errors.map(String).join("\n");
	if (typeof result.error === "string") return result.error;
	return `Claude Code failed: ${result.subtype ?? "unknown result"}`;
}

/** Name a failure as a rate limit when a rejection preceded it.
 *
 *  pi has no typed rate-limit error — `stopReason` is only ever "error" and the sole carrier
 *  is `errorMessage` — so everything that reacts to a rate limit pattern-matches that string:
 *  pi-subagents gates `fallbackModels` on its own pattern list, and key-rotating extensions use
 *  their own. Claude Code words a subscription limit as "You're out of extra usage · resets
 *  6:30pm", which matches none of them, so an exhausted quota reads as a fatal error and the
 *  fallback chain never runs (issue #58).
 *
 *  Leading with "Claude rate limit" rather than appending keeps the phrase in any truncated
 *  render, and avoids the `<tool> failed (exit N):` shape that pi-subagents treats as a tool
 *  failure and refuses to retry. */
export function describeRateLimitFailure(
	rejection: { rateLimitType?: string; resetsAt?: number },
	failure: string,
): string {
	const kind = rejection.rateLimitType ? ` (${rejection.rateLimitType})` : "";
	const resets = rejection.resetsAt ? ` — resets ${new Date(rejection.resetsAt * 1000).toLocaleTimeString()}` : ""; // resetsAt: Unix seconds (unit undocumented in the SDK; observed)
	return `Claude rate limit${kind}${resets}: ${failure}`;
}

interface IsolatedAttempt {
	text: string;
	errorText?: string;
	retryAfterMs?: number;
	quotaFailure: QueryContext["quotaFailure"];
}

/** Drain one isolated query: its text, its failure, and the rate-limit rejection that caused it. */
async function consumeIsolatedQuery(
	sdkQuery: ReturnType<typeof query>,
	model: Model<Api>,
	aborted: () => boolean,
): Promise<IsolatedAttempt> {
	let assistantText = "";
	let finalText = "";
	let errorText: string | undefined;
	let retryAfterMs: number | undefined;
	let rejection: QueryContext["rateLimitRejection"] = null;
	let quotaFailure: QueryContext["quotaFailure"] = null;
	let firstEventLogged = false;
	try {
		for await (const message of sdkQuery) {
			if (!firstEventLogged) {
				debug(`compact summary: first event type=${message.type}`);
				firstEventLogged = true;
			}
			if (aborted()) break;

			if (message.type === "assistant") {
				for (const block of message.message?.content ?? []) {
					if (block.type === "text" && typeof block.text === "string") assistantText += block.text;
				}
			} else if (message.type === "rate_limit_event") {
				const info = message.rate_limit_info;
				if (info?.status === "rejected") rejection = info;
			} else if (message.type === "result") {
				logServedContextWindow("compact summary", message, model);
				errorText = resultErrorText(message);
				// A rejection belongs only to the failure Claude Code sends next.
				quotaFailure = errorText ? classifyAccountFailure(errorText, rejection) : null;
				if (errorText && rejection) {
					errorText = describeRateLimitFailure(rejection, errorText);
					if (rejection.resetsAt !== undefined && Number.isFinite(rejection.resetsAt)) {
						retryAfterMs = Math.max(0, rejection.resetsAt * 1000 - Date.now());
					}
				}
				rejection = null;
				if (!errorText && message.subtype === "success") finalText = message.result || assistantText;
			}
		}
	} catch (error) {
		// Claude Code exits non-zero after a quota error result, so the SDK throws; the caller still rotates accounts.
		if (!quotaFailure) throw error;
	}
	return { text: finalText || assistantText, errorText, retryAfterMs, quotaFailure };
}

async function consumeIsolatedQueryWithAuthTrace(
	sdkQuery: ReturnType<typeof query>,
	model: Model<Api>,
	aborted: () => boolean,
	profile: AuthTraceProfile | undefined,
): Promise<IsolatedAttempt> {
	try {
		const attempt = await consumeIsolatedQuery(sdkQuery, model, aborted);
		recordAuthFailure(profile, attempt.errorText);
		return attempt;
	} catch (error) {
		recordAuthFailure(profile, errorMessage(error));
		throw error;
	}
}

export function isolatedStreamFn(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void runIsolatedSummary(model, context, options, stream);
	return stream;
}

export async function runIsolatedSummary(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	let sdkQuery: ReturnType<typeof query> | undefined;
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		void sdkQuery?.interrupt().catch(() => {});
		try {
			sdkQuery?.close();
		} catch {}
	};

	try {
		// One-off summarizer calls (compaction, branch summary, turn prefix, bug report —
		// anything routed through pi's completeSummarization) are marked cacheRetention:
		// "none". Any of them may appear in a future pi release without a bridge change,
		// so route on the marker, not on which summarizer is calling. Non-summarizer calls
		// must still match the [system,user] compaction shape exactly.
		const isOneOffSummary = options?.cacheRetention === "none";
		const promptText = isOneOffSummary
			? extractUserPrompt(context.messages)
			: extractIsolatedSummaryPrompt(context.messages);
		if (!promptText)
			throw new Error("runIsolatedSummary: one-off summary without a user prompt (last message is not user?)");
		const cwd = requireSessionCwd(options);
		const compactProviderSettings = loadConfig(cwd).provider;
		const compactClaudeExecutable = resolveClaudeCodeExecutable(compactProviderSettings?.pathToClaudeCodeExecutable);
		const cliModel = claudeCodeModelId(model, longContextSettings);
		debug(`compact summary: spawn model=${cliModel} registeredModel=${model.id} promptLen=${promptText.length}`);

		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		let finalText = "";
		let errorText: string | undefined;
		let retryAfterMs: number | undefined;
		let account: ReturnType<typeof prepareProviderAccount>;
		try {
			account = prepareProviderAccount();
		} catch (error) {
			if (!(error instanceof Error) || error.message !== ACCOUNTS_EXHAUSTED) throw error;
			await fetchAccountRetryProfiles(model, options?.signal);
			if (options?.signal?.aborted) throw new Error("Claude account quota recheck cancelled");
			account = prepareProviderAccount();
		}
		// One attempt per account: never re-probe usage inside this request.
		const attempted = new Set<string>();
		for (;;) {
			if (account) {
				if (attempted.has(account.name)) {
					errorText = ACCOUNTS_EXHAUSTED;
					break;
				}
				attempted.add(account.name);
			}
			let attempt: IsolatedAttempt;
			try {
				if (options?.signal?.aborted) throw new Error("Claude account quota recheck cancelled");
				sdkQuery = isolatedQueryImpl({
					prompt: promptText,
					options: {
						cwd,
						env: {
							...process.env,
							...CC_CHILD_ENV,
							...(account ? { CLAUDE_CONFIG_DIR: account.configDir } : {}),
						},
						settings: { autoMemoryEnabled: false },
						tools: [],
						strictMcpConfig: true,
						settingSources: [] as SettingSource[],
						skills: [],
						persistSession: false,
						systemPrompt: context.systemPrompt,
						model: cliModel,
						maxTurns: 1,
						...(compactClaudeExecutable ? { pathToClaudeCodeExecutable: compactClaudeExecutable } : {}),
						...makeCliDebugOptions("compact-summary", account),
					},
				});
				if (wasAborted) onAbort();
				attempt = await consumeIsolatedQueryWithAuthTrace(sdkQuery, model, () => wasAborted, account);
			} finally {
				if (account) recordCredentialTrace(account, "settled", "isolated");
			}
			finalText = attempt.text;
			errorText = attempt.errorText;
			retryAfterMs = attempt.retryAfterMs;
			const quotaRejection = attempt.quotaFailure;
			if (wasAborted || !errorText || !account || !quotaRejection) break;
			const next = account.manager.reject(account.name, quotaRejection.resetsAt, Date.now() / 1000);
			debug(`compact summary: ${account.name} quota rejected; ${next ? `retrying on ${next}` : "no account left"}`);
			if (next === undefined) {
				errorText = ACCOUNTS_EXHAUSTED;
				retryAfterMs = undefined;
				break;
			}
			account = prepareProviderAccount();
		}

		if (wasAborted) {
			const output = newAssistantOutput(model, "", "aborted", "Operation aborted");
			debug("compact summary: aborted");
			stream.push({ type: "error", reason: "aborted", error: output });
			stream.end();
			return;
		}

		const text = finalText;
		if (errorText || !text.trim()) {
			const msg = errorText ?? "Claude Code summary returned empty text";
			debug(`compact summary: error ${msg}`);
			const output = newAssistantOutput(model, "", "error", msg);
			if (retryAfterMs !== undefined) output.retryAfterMs = retryAfterMs;
			stream.push({ type: "error", reason: "error", error: output });
			stream.end();
			return;
		}

		debug(`compact summary: done textLen=${text.length}`);
		stream.push({ type: "done", reason: "stop", message: newAssistantOutput(model, text, "stop") });
		stream.end();
	} catch (err) {
		if (wasAborted) {
			debug("compact summary: aborted while the query threw", err);
			stream.push({
				type: "error",
				reason: "aborted",
				error: newAssistantOutput(model, "", "aborted", "Operation aborted"),
			});
			stream.end();
			return;
		}
		const msg = errorMessage(err);
		debug("runIsolatedSummary threw; pushing terminal error", err);
		stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
		stream.end();
	} finally {
		options?.signal?.removeEventListener("abort", onAbort);
		try {
			sdkQuery?.close();
		} catch {}
	}
}

export function requireSessionCwd(options?: SimpleStreamOptions): string {
	if (!options?.cwd) throw new Error("Claude bridge launch requires the current Pi session cwd");
	return options.cwd;
}
