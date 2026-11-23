import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { type BranchSummaryResult, generateBranchSummary } from "../../../src/core/compaction/branch-summarization.ts";
import { compact } from "../../../src/core/compaction/compaction.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import {
	configureAccountRuntime,
	errorMessage,
	providerSettings,
	registerClaudeUsageListener,
} from "./account-runtime.ts";
import { resolveClaudeCodeExecutable } from "./bundled-runtime.ts";
import { loadConfig } from "./config.ts";
import { PROVIDER_ID } from "./convert.ts";
import { debug, moduleInstanceId } from "./diagnostics.ts";
import { isolatedStreamFn, longContextSettings, setLongContextSettings } from "./isolated-summary.ts";
import { applyLongContext, type buildModels } from "./models.ts";
import type { PromptCaptures } from "./prompt-capture.ts";
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
	clearPendingToolFailures(): void;
	streamClaudeAgentSdk: (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
		allowQuotaRecheck?: boolean,
	) => AssistantMessageEventStream;
	activeStreamSimpleKey: symbol;
	promptCaptures: PromptCaptures;
	closeEndedTurn: (piSessionId: string | null, runMessages: Context["messages"]) => Promise<void>;
	reportLeaks(label: string): void;
	branchSummaryOutcome(
		result: BranchSummaryResult,
	): { cancel: true } | { summary: { summary: string; details: unknown } };
}

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
					skills?: Parameters<PromptCaptures["record"]>[1]["skills"];
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

	// The compaction hook supplies the result; session_before_compact can only cancel.
	pi.on("compaction", async (event, ctx) => {
		if (ctx.model?.baseUrl !== "claude-bridge") return undefined;
		debug(
			`compaction: takeover reason=${event.reason} willRetry=${event.willRetry} ` +
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
			debug(`compaction: takeover complete summaryLen=${compaction.summary.length}`);
			return { compaction };
		} catch (err) {
			const msg = errorMessage(err);
			debug("compaction: takeover failed; cancelling to avoid native compact fallback", err);
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
}
