import type { Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "../../../src/core/extensions/types.ts";

const FAST_STATUS_KEY = "codex-fast";
const PRIORITY_SERVICE_TIER = "priority";
const ULTRAFAST_SERVICE_TIER = "ultrafast";
const SUPPORTED_PROVIDERS = new Set(["openai-codex", "openai-codex-gc"]);

type FastServiceTier = typeof PRIORITY_SERVICE_TIER | typeof ULTRAFAST_SERVICE_TIER;

function supportsFastMode(model: Model<string> | undefined): boolean {
	return model !== undefined && SUPPORTED_PROVIDERS.has(model.provider);
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
	const label = fastModeLabel(state.serviceTier);
	const status = label === "ultra" ? "fast ultra" : "fast";
	ctx.ui.setStatus(FAST_STATUS_KEY, state.serviceTier && supportsFastMode(model) ? status : undefined);
}

export interface FastModeAuthority {
	serviceTier: FastServiceTier | undefined;
}

export interface CodexFastOptions {
	authority: FastModeAuthority;
}

function isChildRuntime(ctx: ExtensionContext): boolean {
	return (
		ctx.multiAgentAgentId !== undefined ||
		ctx.multiAgentRequiresAgentId === true ||
		ctx.sessionManager?.isSubagentSession?.() === true
	);
}

async function handleFastCommand(
	args: string,
	ctx: ExtensionCommandContext,
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
		ctx.ui.notify("Fast mode requires openai-codex or openai-codex-gc", "warning");
		clearEditor(ctx);
		return;
	}

	authority.serviceTier = requested === false ? undefined : requested;
	updateFastStatus(ctx, authority);
	ctx.ui.notify(`Fast mode: ${fastModeLabel(authority.serviceTier)}`, "info");
	clearEditor(ctx);
}

export default function codexFastExtension(pi: ExtensionAPI, options?: CodexFastOptions): void {
	const authority = options?.authority ?? { serviceTier: undefined };
	pi.registerCommand("fast", {
		description: "Toggle Codex priority or ultrafast processing from the main thread",
		handler: (args, ctx) => handleFastCommand(args, ctx, authority),
	});
	pi.on("session_start", (event, ctx) => {
		if (!isChildRuntime(ctx) && event.reason !== "reload") authority.serviceTier = undefined;
		updateFastStatus(ctx, authority);
	});
	pi.on("model_select", (event, ctx) => {
		updateFastStatus(ctx, authority, event.model);
	});
	pi.on("before_provider_request", (event, ctx) => {
		if (!authority.serviceTier || !supportsFastMode(ctx.model)) return undefined;
		if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
			ctx.ui.notify("Fast mode skipped: provider payload is not an object", "warning");
			return undefined;
		}
		return { ...event.payload, service_tier: authority.serviceTier };
	});
}
