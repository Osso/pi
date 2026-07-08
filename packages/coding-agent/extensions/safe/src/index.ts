import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

type SafeCommandAction = "on" | "off" | "status";

const safeStatusKey = "safe";
const safeStatusText = "safe:on";
const safeCommandActions: SafeCommandAction[] = ["on", "off", "status"];
const allowedSafeModeTools: ReadonlySet<string> = new Set(["web_search", "ask_questions"]);

function safeModeStatus(enabled: boolean): string {
	return enabled ? "Safe mode is on" : "Safe mode is off";
}

function updateSafeStatus(ctx: ExtensionContext, enabled: boolean): void {
	ctx.ui.setStatus(safeStatusKey, enabled ? safeStatusText : undefined);
}

function isSafeCommandAction(value: string): value is SafeCommandAction {
	return safeCommandActions.includes(value as SafeCommandAction);
}

function parseSafeCommand(args: string): SafeCommandAction | undefined {
	const value = args.trim();
	return isSafeCommandAction(value) ? value : undefined;
}

function blockDisallowedTool(event: ToolCallEvent, enabled: boolean): ToolCallEventResult | undefined {
	if (!enabled || allowedSafeModeTools.has(event.toolName)) return undefined;
	return { block: true, reason: `Safe mode blocks tool: ${event.toolName}` };
}

export default function safeExtension(pi: ExtensionAPI) {
	let enabled = false;

	pi.on("session_start", async (_event, ctx) => {
		updateSafeStatus(ctx, enabled);
	});

	pi.registerToolGate(async (event) => blockDisallowedTool(event, enabled));

	pi.registerCommand("safe", {
		description: "Restrict tool calls to web_search and ask_questions for this session.",
		getArgumentCompletions: (prefix) => {
			const matches = safeCommandActions.filter((action) => action.startsWith(prefix));
			return matches.length > 0 ? matches.map((action) => ({ value: action, label: action })) : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const action = parseSafeCommand(args || "status");
			if (!action) {
				ctx.ui.notify("Usage: /safe on|off|status", "error");
				return;
			}

			if (action === "status") {
				ctx.ui.notify(safeModeStatus(enabled), "info");
				return;
			}

			enabled = action === "on";
			updateSafeStatus(ctx, enabled);
			ctx.ui.notify(enabled ? "Safe mode enabled" : "Safe mode disabled", "info");
			ctx.ui.setEditorText("");
		},
	});
}
