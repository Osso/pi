import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { type BranchSummaryResult, generateBranchSummary } from "../../../src/core/compaction/branch-summarization.ts";
import { compact } from "../../../src/core/compaction/compaction.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import { buildSessionContext } from "../../../src/core/session-manager.ts";
import { keyHint } from "../../../src/modes/interactive/components/keybinding-hints.ts";
import {
	configureAccountRuntime,
	errorMessage,
	providerSettings,
	registerClaudeUsageListener,
} from "./account-runtime.ts";
import {
	askClaudeCallTags,
	askClaudeToolDescription,
	buildAskClaudeParams,
	resolveAskClaudeDefaults,
	resolveAskClaudeMode,
} from "./askclaude-schema.ts";
import { buildActionSummary, type ToolCallState } from "./askclaude-ui.ts";
import { resolveClaudeCodeExecutable } from "./bundled-runtime.ts";
import { loadConfig } from "./config.ts";
import { PROVIDER_ID } from "./convert.ts";
import { debug, moduleInstanceId } from "./diagnostics.ts";
import { isolatedStreamFn, longContextSettings, setLongContextSettings } from "./isolated-summary.ts";
import { applyLongContext, type buildModels } from "./models.ts";
import type { PromptCaptureStore } from "./prompt-and-wait.ts";
import { getAskClaudeQueryImpl, promptAndWait } from "./prompt-and-wait.ts";
import { closeActiveQueries } from "./query-lifecycle.ts";
import {
	historyRewrittenBySession,
	reinjectPriorCompactionFileOps,
	sharedSessions,
	sponsorMarkRebuildForSession,
} from "./session-mirror.ts";
import { setPiUI } from "./ui-state.ts";

export interface ExtensionRegistrationDependencies {
	models: ReturnType<typeof buildModels>;
	pendingNotices: string[];
	setPiMode(mode: ExtensionContext["mode"]): void;
	setAskClaudeToolName(name: string): void;
	clearPendingToolFailures(): void;
	streamClaudeAgentSdk: (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
		allowQuotaRecheck?: boolean,
	) => AssistantMessageEventStream;
	activeStreamSimpleKey: symbol;
	promptCaptures: PromptCaptureStore;
	closeEndedTurn: (piSessionId: string | null, runMessages: Context["messages"]) => Promise<void>;
	reportLeaks(label: string): void;
	branchSummaryOutcome(
		result: BranchSummaryResult,
	): { cancel: true } | { summary: { summary: string; details: unknown } };
}

const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

// --- Extension registration ---

export function registerExtension(pi: ExtensionAPI, dependencies: ExtensionRegistrationDependencies): void {
	// Disable non-essential Claude Code traffic (update checks, MCP registry, telemetry)
	process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

	const config = loadConfig(pi.cwd);
	debug("loadConfig:", JSON.stringify(config));
	const settings = config.provider ?? {};
	configureAccountRuntime(settings, resolveClaudeCodeExecutable(settings.pathToClaudeCodeExecutable));
	registerClaudeUsageListener(pi);
	// We need these settings to know if we're eligible for 1M context on certain models
	// Validate at the boundary: a non-array here would throw inside every
	// claudeCodeModelId call and brick the extension at activation.
	const forceTwoHundredK = Array.isArray(providerSettings.forceTwoHundredK)
		? providerSettings.forceTwoHundredK.filter((id): id is string => typeof id === "string")
		: undefined;
	setLongContextSettings({
		plan: providerSettings.plan ?? "pro",
		longContextExtraUsage: providerSettings.longContextExtraUsage ?? false,
		forceTwoHundredK,
	});
	const registeredModels = applyLongContext(dependencies.models, longContextSettings);
	if (registeredModels.length === 0) {
		console.error(
			"claude-bridge: no models available from pi-ai's anthropic catalog — update @earendil-works/pi-ai (requires >=0.86.1)",
		);
	}

	if (!config.startupNoticeShown) {
		if (config.provider?.plan === undefined)
			dependencies.pendingNotices.push(
				'Are you using a Max plan? You need to set provider.plan to "max" to unlock 1M context in Opus.',
			);
		if (config.askClaude?.enabled === undefined)
			dependencies.pendingNotices.push("The AskClaude tool is opt-in only. Set askClaude.enabled to use it.");
	}

	// Reset shared session on pi session lifecycle events
	const clearSession = (event: string) => {
		debug(`${event}: clearing ${sharedSessions.size} shared session${sharedSessions.size === 1 ? "" : "s"}`);
		// Whole map: children never emit session_shutdown (only runtime teardown
		// and /reload do), so there is no per-entry removal to do here — the
		// top-level transition takes every mirror with it.
		sharedSessions.clear();
		dependencies.clearPendingToolFailures();
		historyRewrittenBySession.clear();

		// Clear the global streamSimple if this instance registered it.
		// This allows /reload to work — the old instance clears the flag so
		// the new instance can register fresh without wrapping stale state.
		const g = globalThis as Record<symbol, unknown>;
		if (g[dependencies.activeStreamSimpleKey] === dependencies.streamClaudeAgentSdk) {
			debug(`${event}: clearing ACTIVE_STREAM_SIMPLE_KEY`);
			g[dependencies.activeStreamSimpleKey] = undefined;
		}
	};
	pi.on("session_start", (event, ctx) => {
		setPiUI(ctx.ui);
		dependencies.setPiMode(ctx.mode);
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			clearSession(`session_start:${event.reason}`);
		}
	});
	// `--system-prompt` replaces pi's default rather than adding to it, but Claude
	// Code's preset carries its own tool and permission guidance that the bridge
	// still depends on, so both flags are forwarded as an append.
	//
	// The options (custom/append/contextFiles/skills/sections) are pi config, stable across a
	// turn; only the auto-generated tool list in the rendered prompt varies. Stash them
	// at before_agent_start so the agent_start recording below can reuse them.
	type RecordOptions = Parameters<typeof recordSystemPrompt>[2];
	let lastSystemPromptOptions: RecordOptions | undefined;
	function recordSystemPrompt(
		source: string,
		systemPrompt: string | undefined,
		options:
			| {
					customPrompt?: string;
					appendSystemPrompt?: string;
					contextFiles?: { path: string; content: string }[];
					skills?: Parameters<PromptCaptureStore["record"]>[1]["skills"];
					sections?: Record<string, string>;
					selectedTools?: string[];
			  }
			| undefined,
	) {
		if (!systemPrompt) return;
		const hasRead = !options?.selectedTools || options.selectedTools.includes("read");
		dependencies.promptCaptures.record(
			systemPrompt,
			{
				custom: options?.customPrompt,
				append: options?.appendSystemPrompt,
				contextFiles: options?.contextFiles ?? [],
				skills: hasRead ? (options?.skills ?? []) : [],
				sections: options?.sections,
			},
			source,
		);
	}
	pi.on("before_agent_start", (event) => {
		lastSystemPromptOptions = event.systemPromptOptions;
		recordSystemPrompt("before_agent_start", event.systemPrompt, event.systemPromptOptions);
	});
	// The prompt the provider actually queries with is the fully-widened one: MCP tool
	// descriptions merge into the system prompt only after their servers connect, which
	// is after before_agent_start. ctx.getSystemPrompt() returns that widened prompt by
	// agent_start (verified: before_agent_start=10,988 chars vs agent_start/query=23,479).
	// A subagent embeds the widened parent prompt verbatim (pi-subagents reads
	// ctx.getSystemPrompt() at dispatch), so unless the widened prompt is a capture key
	// too, the child's turn resolves against nothing, falls to a verbatim side request,
	// and ships pi's harness — tripping the server's third-party plan-eligibility check
	// ("out of extra usage"). Recording it here, before the query, restores the match.
	//
	// agent_start also captures a handler-returned forceSystemPrompt, which
	// buildSystemPrompt renders verbatim.
	pi.on("agent_start", (_event, ctx) => {
		recordSystemPrompt("agent_start", ctx.getSystemPrompt(), lastSystemPromptOptions);
	});

	// Mid-run re-renders: turn_start fires before every turn (first turn included)
	// after the turn's prompt is final: prepareNextTurnWithContext has
	// re-rendered the options (pi's section-based prompt) and any mid-run
	// setActiveToolsByName rebuild has already landed. Re-keying at each boundary
	// the prompt can change at keeps exact-match alive mid-run. The stashed options can
	// lag a mid-run tool-loadout change, which skews the hasRead skills filter until the
	// next before_agent_start — accepted: a stale skills list beats failing the turn.
	pi.on("turn_start", (_event, ctx) => {
		recordSystemPrompt("turn_start", ctx.getSystemPrompt(), lastSystemPromptOptions);
	});
	pi.on("agent_end", (event, ctx) =>
		dependencies.closeEndedTurn(ctx.sessionManager.getSessionId(), event.messages as Context["messages"]),
	);
	pi.on("session_shutdown", (_event, ctx) => {
		dependencies.reportLeaks("session_shutdown");
		closeActiveQueries(ctx.sessionManager.getSessionId(), "pi session shut down");
		clearSession("session_shutdown");
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (ctx.model?.baseUrl !== "claude-bridge") return undefined;
		debug(
			`session_before_compact: takeover reason=${event.reason} willRetry=${event.willRetry} ` +
				`isSplitTurn=${event.preparation.isSplitTurn} messages=${event.preparation.messagesToSummarize.length} ` +
				`turnPrefix=${event.preparation.turnPrefixMessages.length}`,
		);
		try {
			reinjectPriorCompactionFileOps(event.branchEntries, event.preparation);
			const compaction = await compact(
				event.preparation,
				ctx.model,
				undefined,
				undefined,
				event.customInstructions,
				event.signal,
				undefined,
				(model, context, options) => isolatedStreamFn(model, context, { ...options, cwd: ctx.cwd }),
				undefined,
			);
			debug(`session_before_compact: takeover complete summaryLen=${compaction.summary.length}`);
			return { compaction };
		} catch (err) {
			const msg = errorMessage(err);
			debug("session_before_compact: takeover failed; cancelling to avoid native compact fallback", err);
			ctx.ui?.notify?.(
				`Claude bridge compact failed (${msg}); cancelled to avoid known hang. Retry, switch model, or reduce context.`,
				"error",
			);
			return { cancel: true };
		}
	});

	// pi /compact and session-tree navigation (rewind / fork-at-point /
	// branch switch) both mutate pi's messages array out from under the
	// bridge. syncSharedSession's REUSE check would otherwise see
	// slice(cursor) === [] (or skip entries) and keep --resume'ing a CC
	// session that no longer matches pi's history. /compact in particular
	// triggers CC's autocompact-thrashing guard (issue #8). Force the next
	// call down the REBUILD path so CC sees the current history — and, when a
	// query is parked at a tool boundary while this fires, discard that query
	// instead of resuming it (markRebuild, discardRewrittenQuery).
	//
	// Attributed to the compacting session (ctx.sessionManager belongs to the
	// session whose runner fired this), so a subagent compacting while its
	// parent sits parked on the Agent tool result discards nothing — the parent's
	// query is live and its conversation untouched. Registered by every instance
	// of this module; instances sponsoring stale marks forward them to the
	// serving instance via sponsorMarkRebuildForSession.
	pi.on("session_compact", (event, ctx) =>
		sponsorMarkRebuildForSession(
			ctx.sessionManager.getSessionId(),
			`session_compact:${event.reason}:willRetry=${event.willRetry}`,
		),
	);
	pi.on("session_tree", (_event, ctx) =>
		sponsorMarkRebuildForSession(ctx.sessionManager.getSessionId(), "session_tree"),
	);

	// Branch summarization — rewind or fork-at-point with "summarize" — is the other
	// place pi asks the model for a summary, and unlike compaction it runs through
	// the *agent's* stream function (agent-session passes `streamFn:
	// this.agent.streamFunction`). On a bridge model that reaches this provider
	// carrying pi's internal summarization prompt, which no `before_agent_start`
	// ever recorded, so the prompt-capture resolver has nothing to resolve it to.
	// Take it over the way compaction is taken over: the summary runs as its own
	// Claude Code subprocess, never touching the live session or the resolver.
	pi.on("session_before_tree", async (event, ctx) => {
		if (ctx.model?.baseUrl !== "claude-bridge") return undefined;
		const { entriesToSummarize, userWantsSummary, customInstructions, replaceInstructions } = event.preparation;
		if (!userWantsSummary || entriesToSummarize.length === 0) return undefined;
		debug(
			`session_before_tree: takeover entries=${entriesToSummarize.length} target=${event.preparation.targetId.slice(0, 8)}`,
		);
		try {
			const result = await generateBranchSummary(entriesToSummarize, {
				model: ctx.model,
				apiKey: "not-used",
				signal: event.signal,
				customInstructions,
				replaceInstructions,
				streamFn: (model, context, options) => isolatedStreamFn(model, context, { ...options, cwd: ctx.cwd }),
			});
			return dependencies.branchSummaryOutcome(result);
		} catch (err) {
			debug("session_before_tree: takeover failed; cancelling navigation", err);
			ctx.ui?.notify?.(`Claude bridge branch summary failed (${errorMessage(err)}); navigation cancelled.`, "error");
			return { cancel: true };
		}
	});

	// --- Provider ---
	//
	// Registration policy across module instances (a subagent session can load
	// this module fresh): the FIRST instance registers unconditionally at load,
	// which is what puts claude-bridge models in the picker before any session
	// starts. Later instances decide at session_start, when ctx.modelRegistry
	// reveals who owns this session's registry:
	//
	// - Registry already has the provider (host passes the parent's registry down,
	//   e.g. pi-subagents >=0.14.3): skip. Re-registering would overwrite the
	//   parent's pinned streamSimple with this instance's fresh — empty-state —
	//   stream fn, and the parent's next tool-result delivery would route into it.
	// - Registry lacks the provider (host gives the child its own, e.g. older
	//   pi-subagents forks): register, or every claude-bridge/* dispatch in the
	//   child fails with "Model not found" (#91). Even loading the bridge via the
	//   agent's `extensions:` frontmatter didn't help there — the module loaded,
	//   hit the old skip-guard, and the child's registry stayed empty.
	//
	// A per-instance stream fn registered into a per-instance registry is
	// self-consistent: that session's traffic flows through this module state,
	// which starts clean and serves only that session.
	//
	// On session_shutdown (including /reload), clearSession() resets
	// ACTIVE_STREAM_SIMPLE_KEY so a freshly loaded module can register as first
	// again.

	const g = globalThis as Record<symbol, unknown>;
	const providerConfig = {
		baseUrl: "claude-bridge",
		apiKey: "not-used",
		api: "claude-bridge",
		models: registeredModels,
		streamSimple: dependencies.streamClaudeAgentSdk,
	};
	if (!g[dependencies.activeStreamSimpleKey]) {
		// First instance: store our streamSimple and register.
		g[dependencies.activeStreamSimpleKey] = dependencies.streamClaudeAgentSdk;
		pi.registerProvider(PROVIDER_ID, providerConfig);
	} else {
		// Later instance: register only if this session's registry lacks the provider.
		debug(`provider: deferring registration decision to session_start (module=${moduleInstanceId})`);
		pi.on("session_start", (_event, ctx) => {
			if (ctx.modelRegistry.getAll().some((model) => model.provider === PROVIDER_ID)) {
				debug(`provider: registry already has ${PROVIDER_ID}, skipping registration (module=${moduleInstanceId})`);
				return;
			}
			debug(`provider: registry lacks ${PROVIDER_ID}, registering (module=${moduleInstanceId})`);
			pi.registerProvider(PROVIDER_ID, providerConfig);
		});
	}

	// --- AskClaude tool ---

	const askConf = config.askClaude;
	const askDefaults = resolveAskClaudeDefaults(askConf);
	dependencies.setAskClaudeToolName(askConf?.name ?? "AskClaude");

	if (askConf?.enabled) {
		const askClaudeParams = buildAskClaudeParams(askDefaults);
		pi.registerTool<typeof askClaudeParams>({
			name: askConf?.name ?? "AskClaude",
			label: askConf?.label ?? "Ask Claude Code",
			description: askClaudeToolDescription(askDefaults, askConf?.description),
			parameters: askClaudeParams,
			renderCall(args, theme) {
				let text = theme.fg("mdLink", theme.bold("AskClaude "));
				const tags = askClaudeCallTags(args, askDefaults);
				if (tags.length) text += `${theme.fg("accent", `[${tags.join(", ")}]`)} `;
				const truncated =
					args.prompt.length > PREVIEW_MAX_CHARS ? args.prompt.substring(0, PREVIEW_MAX_CHARS) : args.prompt;
				const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
				text += theme.fg("muted", `"${lines.join("\n")}"`);
				if (args.prompt.length > PREVIEW_MAX_CHARS || args.prompt.split("\n").length > PREVIEW_MAX_LINES)
					text += theme.fg("dim", " …");
				return new Text(text, 0, 0);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				if (isPartial) {
					const status = result.content[0]?.type === "text" ? result.content[0].text : "working...";
					return new Text(theme.fg("mdLink", "◉ Claude Code ") + theme.fg("muted", status), 0, 0);
				}

				const details = result.details as
					| { prompt?: string; executionTime?: number; actions?: string; error?: boolean }
					| undefined;
				const body = result.content[0]?.type === "text" ? result.content[0].text : "";

				let text = details?.error ? theme.fg("error", "✗ Claude Code error") : theme.fg("mdLink", "✓ Claude Code");

				if (details?.executionTime) text += ` ${theme.fg("dim", `${(details.executionTime / 1000).toFixed(1)}s`)}`;
				if (details?.actions) text += ` ${theme.fg("muted", details.actions)}`;

				if (expanded) {
					if (details?.prompt) text += `\n${theme.fg("dim", `Prompt: ${details.prompt}`)}`;
					if (details?.prompt && body) text += `\n${theme.fg("dim", "─".repeat(40))}`;
					if (body) text += `\n${theme.fg("toolOutput", body)}`;
				} else {
					const truncated = body.length > PREVIEW_MAX_CHARS ? body.substring(0, PREVIEW_MAX_CHARS) : body;
					const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
					if (lines.length) text += `\n${theme.fg("toolOutput", lines.join("\n"))}`;
					if (body.length > PREVIEW_MAX_CHARS || body.split("\n").length > PREVIEW_MAX_LINES)
						text += `\n${theme.fg("dim", `… (${keyHint("app.tools.expand", "to expand")})`)}`;
				}

				return new Text(text, 0, 0);
			},
			async execute(_id, params, signal, onUpdate, ctx) {
				// Guard: circular delegation
				if (ctx.model?.baseUrl === "claude-bridge") {
					debug("askClaude: blocked circular delegation (active provider is claude-bridge)");
					return {
						content: [
							{
								type: "text" as const,
								text: "Error: AskClaude cannot be used when the active provider is claude-bridge — you're already running through Claude Code.",
							},
						],
						details: { error: true },
					};
				}

				const mode = resolveAskClaudeMode(params.mode, askDefaults);
				const isolated = params.isolated ?? askDefaults.isolated;
				const toolCalls = new Map<string, ToolCallState>();
				const start = Date.now();

				const progressInterval = setInterval(() => {
					const elapsed = ((Date.now() - start) / 1000).toFixed(0);
					const summary = buildActionSummary(toolCalls, ctx.cwd);
					const status = summary ? `${elapsed}s — ${summary}` : `${elapsed}s — working...`;
					onUpdate?.({
						content: [{ type: "text", text: status }],
						details: { prompt: params.prompt, executionTime: Date.now() - start },
					});
				}, 1000);

				try {
					const result = await promptAndWait(
						{
							models: dependencies.models,
							promptCaptures: dependencies.promptCaptures,
							query: getAskClaudeQueryImpl(),
						},
						ctx.cwd,
						params.prompt,
						mode,
						toolCalls,
						signal,
						{
							systemPrompt: ctx.getSystemPrompt(),
							appendSkills: askConf?.appendSkills,
							model: params.model,
							thinking: params.thinking,
							isolated,
							context: isolated
								? undefined
								: (buildSessionContext(ctx.sessionManager.getBranch()).messages as Context["messages"]),
							piSessionId: ctx.sessionManager.getSessionId(),
						},
					);
					clearInterval(progressInterval);
					onUpdate?.({ content: [{ type: "text", text: "" }], details: {} });
					const executionTime = Date.now() - start;
					const actions = buildActionSummary(toolCalls, ctx.cwd);

					const text = actions
						? `${result.responseText}\n\n[Claude Code actions: ${actions}]`
						: result.responseText;
					return {
						content: [{ type: "text" as const, text }],
						details: { prompt: params.prompt, executionTime, actions },
					};
				} catch (err) {
					clearInterval(progressInterval);
					debug(
						`askClaude error: mode=${mode}, model=${params.model ?? "default"}, isolated=${isolated}, elapsed=${((Date.now() - start) / 1000).toFixed(1)}s, error=`,
						err,
					);
					const msg = errorMessage(err);
					return {
						content: [{ type: "text" as const, text: `Error: ${msg}` }],
						details: { prompt: params.prompt, executionTime: Date.now() - start, error: true },
					};
				}
			},
		});
	}
}
