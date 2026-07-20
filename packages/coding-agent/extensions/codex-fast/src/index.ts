import type { Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "../../../src/core/extensions/types.ts";

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

function updateFastStatus(ctx: ExtensionContext, state: FastModeAuthority, model = ctx.model): void {
	ctx.ui.setStatus(FAST_STATUS_KEY, state.enabled && supportsFastMode(model) ? "fast" : undefined);
}

export interface FastModeAuthority {
	enabled: boolean;
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
	const requested = requestedFastMode(args, authority.enabled);
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

	authority.enabled = requested;
	updateFastStatus(ctx, authority);
	ctx.ui.notify(`Fast mode: ${authority.enabled ? "on" : "off"}`, "info");
	clearEditor(ctx);
}

export default function codexFastExtension(pi: ExtensionAPI, options?: CodexFastOptions): void {
	const authority = options?.authority ?? { enabled: false };
	pi.registerCommand("fast", {
		description: "Toggle Codex priority processing from the main thread",
		handler: (args, ctx) => handleFastCommand(args, ctx, authority),
	});
	pi.on("session_start", (event, ctx) => {
		if (!isChildRuntime(ctx) && event.reason !== "reload") authority.enabled = false;
		updateFastStatus(ctx, authority);
	});
	pi.on("model_select", (event, ctx) => {
		updateFastStatus(ctx, authority, event.model);
	});
	pi.on("before_provider_request", (event, ctx) => {
		if (!authority.enabled || !supportsFastMode(ctx.model)) return undefined;
		if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
			ctx.ui.notify("Fast mode skipped: provider payload is not an object", "warning");
			return undefined;
		}
		return { ...event.payload, service_tier: "priority" };
	});
}
