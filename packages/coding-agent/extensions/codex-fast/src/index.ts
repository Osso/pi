import type { Model } from "@earendil-works/pi-ai";
import { getProviders } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../../src/core/extensions/types.ts";
import { readSessionHistoryReverse } from "../../../src/core/session-history.ts";

const FAST_MODE_ENTRY = "codex-fast-mode";
const FAST_STATUS_KEY = "codex-fast";
const PRIORITY_SERVICE_TIER = "priority";
const ULTRAFAST_SERVICE_TIER = "ultrafast";
const SUPPORTED_PROVIDERS = new Set(["openai-codex", "openai-codex-gc", "openai-codex-team"]);
const BUILT_IN_PROVIDERS = new Set<string>(getProviders());

type FastServiceTier = typeof PRIORITY_SERVICE_TIER | typeof ULTRAFAST_SERVICE_TIER;

type FastModeEntry = {
	serviceTier: FastServiceTier | null;
};

/**
 * Codex providers, plus custom (models.json) providers on the Responses API: a relay such as CLIProxyAPI
 * forwards `service_tier` to Codex. Built-in providers such as `openai` stay unsupported.
 */
function supportsFastMode(model: Model<string> | null | undefined): boolean {
	if (model == null) return false;
	if (SUPPORTED_PROVIDERS.has(model.provider)) return true;
	return model.api === "openai-responses" && !BUILT_IN_PROVIDERS.has(model.provider);
}

function requestedFastMode(
	args: string,
	currentTier: FastServiceTier | undefined,
): FastServiceTier | false | undefined {
	const requested = args.trim().toLowerCase();
	if (!requested) return currentTier === undefined ? PRIORITY_SERVICE_TIER : false;
	if (requested === "on") return PRIORITY_SERVICE_TIER;
	if (requested === "ultra") return ULTRAFAST_SERVICE_TIER;
	if (requested === "off") return false;
	return undefined;
}

function clearEditor(ctx: ExtensionCommandContext): void {
	ctx.ui.setEditorText("");
}

function fastModeLabel(serviceTier: FastServiceTier | undefined): "off" | "on" | "ultra" {
	if (serviceTier === ULTRAFAST_SERVICE_TIER) return "ultra";
	return serviceTier === PRIORITY_SERVICE_TIER ? "on" : "off";
}

function updateFastStatus(ctx: ExtensionContext, state: FastModeAuthority, model = ctx.model): void {
	ctx.ui.setStatus(FAST_STATUS_KEY, (sessionOverride) => {
		const displayedModel = sessionOverride === undefined ? model : sessionOverride.model;
		if (!state.serviceTier || !supportsFastMode(displayedModel)) return undefined;
		return state.serviceTier === ULTRAFAST_SERVICE_TIER ? "fast ultra" : "fast";
	});
}

export interface FastModeAuthority {
	serviceTier: FastServiceTier | undefined;
}

export interface CodexFastOptions {
	authority: FastModeAuthority;
}

function isChildRuntime(ctx: ExtensionContext): boolean {
	return ctx.multiAgentAgentId !== undefined || ctx.multiAgentRequiresAgentId === true;
}

function parsePersistedServiceTier(data: unknown): FastServiceTier | null | undefined {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
	const { serviceTier } = data as { serviceTier?: unknown };
	if (serviceTier === null) return null;
	if (serviceTier === PRIORITY_SERVICE_TIER || serviceTier === ULTRAFAST_SERVICE_TIER) return serviceTier;
	return undefined;
}

/** Newest saved tier on the branch, including entries before a compacted session's loaded slice. */
async function readPersistedFastMode(ctx: ExtensionContext): Promise<FastServiceTier | null | undefined> {
	for await (const entry of readSessionHistoryReverse(ctx.sessionManager)) {
		if (entry.type !== "custom" || entry.customType !== FAST_MODE_ENTRY) continue;
		const persistedTier = parsePersistedServiceTier(entry.data);
		if (persistedTier !== undefined) return persistedTier;
	}
	return undefined;
}

function readConfiguredFastMode(ctx: ExtensionContext): FastServiceTier | undefined {
	const configuredMode = ctx.settingsManager?.getMergedSettings().defaultCodexFastMode;
	if (configuredMode === PRIORITY_SERVICE_TIER || configuredMode === ULTRAFAST_SERVICE_TIER) {
		return configuredMode;
	}
	return undefined;
}

function persistFastMode(pi: ExtensionAPI, authority: FastModeAuthority): void {
	pi.appendEntry<FastModeEntry>(FAST_MODE_ENTRY, { serviceTier: authority.serviceTier ?? null });
}

async function handleFastCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	authority: FastModeAuthority,
): Promise<void> {
	if (isChildRuntime(ctx)) {
		ctx.ui.notify("Fast mode is controlled by the main thread", "warning");
		clearEditor(ctx);
		return;
	}
	const requested = requestedFastMode(args, authority.serviceTier);
	if (requested === undefined) {
		ctx.ui.notify("Usage: /fast [on|off|ultra]", "warning");
		clearEditor(ctx);
		return;
	}
	if (requested !== false && !supportsFastMode(ctx.model)) {
		ctx.ui.notify("Fast mode requires a Codex provider", "warning");
		clearEditor(ctx);
		return;
	}

	authority.serviceTier = requested === false ? undefined : requested;
	persistFastMode(pi, authority);
	updateFastStatus(ctx, authority);
	ctx.ui.notify(`Fast mode: ${fastModeLabel(authority.serviceTier)}`, "info");
	clearEditor(ctx);
}

export default function codexFastExtension(pi: ExtensionAPI, options?: CodexFastOptions): void {
	const authority = options?.authority ?? { serviceTier: undefined };
	pi.registerCommand("fast", {
		description: "Toggle Codex priority or ultrafast processing from the main thread",
		handler: (args, ctx) => handleFastCommand(args, ctx, pi, authority),
	});
	// /tree selects another branch, whose saved /fast choice must apply like it does at startup.
	const restoreFastMode = async (ctx: ExtensionContext) => {
		if (!isChildRuntime(ctx)) {
			const persistedMode = await readPersistedFastMode(ctx);
			authority.serviceTier =
				persistedMode === undefined ? readConfiguredFastMode(ctx) : (persistedMode ?? undefined);
		}
		updateFastStatus(ctx, authority);
	};
	pi.on("session_start", (_event, ctx) => restoreFastMode(ctx));
	pi.on("session_tree", (_event, ctx) => restoreFastMode(ctx));
	pi.on("model_select", (event, ctx) => {
		updateFastStatus(ctx, authority, event.model);
	});
	pi.on("before_provider_request", (event, ctx) => {
		// Decide from the request model: in a pool session ctx.model is the pool, not the serving member.
		if (!authority.serviceTier || !supportsFastMode(event.model)) return undefined;
		if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
			ctx.ui.notify("Fast mode skipped: provider payload is not an object", "warning");
			return undefined;
		}
		return { ...event.payload, service_tier: authority.serviceTier };
	});
}
