import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "../../../src/core/extensions/types.ts";

const FAST_STATUS_KEY = "codex-fast";
const SUPPORTED_PROVIDERS = new Set(["openai-codex", "openai-codex-gc"]);

function supportsFastMode(model: Model<string> | undefined): boolean {
	return model !== undefined && SUPPORTED_PROVIDERS.has(model.provider);
}

function requestedFastMode(args: string, enabled: boolean): boolean | undefined {
	const requested = args.trim().toLowerCase();
	if (!requested) return !enabled;
	if (requested === "on") return true;
	if (requested === "off") return false;
	return undefined;
}

function clearEditor(ctx: ExtensionCommandContext): void {
	ctx.ui.setEditorText("");
}

interface FastModeState {
	enabled: boolean;
}

async function handleFastCommand(args: string, ctx: ExtensionCommandContext, state: FastModeState): Promise<void> {
	const requested = requestedFastMode(args, state.enabled);
	if (requested === undefined) {
		ctx.ui.notify("Usage: /fast [on|off]", "warning");
		clearEditor(ctx);
		return;
	}
	if (requested && !supportsFastMode(ctx.model)) {
		ctx.ui.notify("Fast mode requires openai-codex or openai-codex-gc", "warning");
		clearEditor(ctx);
		return;
	}

	state.enabled = requested;
	ctx.ui.setStatus(FAST_STATUS_KEY, state.enabled ? "fast" : undefined);
	ctx.ui.notify(`Fast mode: ${state.enabled ? "on" : "off"}`, "info");
	clearEditor(ctx);
}

export default function codexFastExtension(pi: ExtensionAPI): void {
	const state: FastModeState = { enabled: false };
	pi.registerCommand("fast", {
		description: "Toggle Codex priority processing for this runtime",
		handler: (args, ctx) => handleFastCommand(args, ctx, state),
	});
	pi.on("before_provider_request", (event, ctx) => {
		if (!state.enabled || !supportsFastMode(ctx.model)) return undefined;
		if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) return undefined;
		return { ...event.payload, service_tier: "priority" };
	});
}
