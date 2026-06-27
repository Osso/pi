import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const intervalPattern = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/;
const minimumIntervalMs = 1_000;

type LoopAction = "start" | "stop" | "status";

interface ActiveLoop {
	intervalMs: number;
	prompt: string;
	timer: ReturnType<typeof setInterval>;
}

interface LoopToolDetails {
	action: LoopAction;
	active: boolean;
	intervalMs?: number;
	prompt?: string;
}

function parseIntervalMs(value: string): number | undefined {
	const match = intervalPattern.exec(value.trim());
	if (!match) return undefined;

	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return undefined;

	const unit = match[2] ?? "s";
	const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
	const intervalMs = Math.floor(amount * multiplier);

	return intervalMs >= minimumIntervalMs ? intervalMs : undefined;
}

function formatInterval(intervalMs: number): string {
	if (intervalMs % 3_600_000 === 0) return `${intervalMs / 3_600_000}h`;
	if (intervalMs % 60_000 === 0) return `${intervalMs / 60_000}m`;
	if (intervalMs % 1_000 === 0) return `${intervalMs / 1_000}s`;
	return `${intervalMs}ms`;
}

function textResult(text: string, details: LoopToolDetails): AgentToolResult<LoopToolDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

function createLoopController(pi: ExtensionAPI) {
	let activeLoop: ActiveLoop | undefined;

	const stop = (): boolean => {
		if (!activeLoop) return false;
		clearInterval(activeLoop.timer);
		activeLoop = undefined;
		return true;
	};

	const start = (intervalMs: number, prompt: string): ActiveLoop => {
		stop();
		const timer = setInterval(() => {
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		}, intervalMs);

		activeLoop = { intervalMs, prompt, timer };
		return activeLoop;
	};

	const status = (): ActiveLoop | undefined => activeLoop;

	return { start, status, stop };
}

function parseLoopCommand(
	args: string,
): { action: "start"; intervalMs: number; prompt: string } | { action: "stop" | "status" } | { error: string } {
	const trimmedArgs = args.trim();
	if (!trimmedArgs || trimmedArgs === "status") return { action: "status" };
	if (trimmedArgs === "stop" || trimmedArgs === "off" || trimmedArgs === "clear") return { action: "stop" };

	const [intervalText, ...promptParts] = trimmedArgs.split(/\s+/);
	const intervalMs = parseIntervalMs(intervalText ?? "");
	if (!intervalMs) {
		return { error: "Usage: /loop <interval> <prompt> | /loop status | /loop stop" };
	}

	const prompt = promptParts.join(" ").trim();
	if (!prompt) {
		return { error: "Loop prompt is required." };
	}

	return { action: "start", intervalMs, prompt };
}

function describeLoop(loop: ActiveLoop | undefined): string {
	if (!loop) return "No active loop";
	return `Loop active every ${formatInterval(loop.intervalMs)}: ${loop.prompt}`;
}

export default function loopExtension(pi: ExtensionAPI) {
	const loop = createLoopController(pi);

	pi.on("session_shutdown", () => {
		loop.stop();
	});

	pi.registerTool({
		name: "loop",
		label: "Loop",
		description: "Start, stop, or inspect a recurring prompt injected into this Pi session.",
		promptSnippet: "Schedule recurring user prompts at a fixed interval, or stop/status the active loop.",
		promptGuidelines: [
			"Use loop only when the user wants recurring follow-up prompts injected into the current session.",
			"Prefer action=status before changing an existing loop when unsure.",
			"Use action=stop when the recurring prompts are no longer needed.",
		],
		approvalRequired: true,
		parameters: Type.Object({
			action: Type.Union([Type.Literal("start"), Type.Literal("stop"), Type.Literal("status")]),
			intervalSeconds: Type.Optional(Type.Number({ description: "Interval in seconds. Required for action=start." })),
			prompt: Type.Optional(Type.String({ description: "Prompt to inject on every interval. Required for action=start." })),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext) => {
			if (params.action === "status") {
				const active = loop.status();
				return textResult(describeLoop(active), {
					action: "status",
					active: Boolean(active),
					intervalMs: active?.intervalMs,
					prompt: active?.prompt,
				});
			}

			if (params.action === "stop") {
				const stopped = loop.stop();
				return textResult(stopped ? "Loop stopped" : "No active loop", { action: "stop", active: false });
			}

			const prompt = params.prompt?.trim();
			const intervalMs =
				params.intervalSeconds !== undefined ? parseIntervalMs(`${params.intervalSeconds}s`) : undefined;

			if (!intervalMs) {
				return textResult("intervalSeconds must be at least 1.", { action: "start", active: false });
			}

			if (!prompt) {
				return textResult("Prompt is required for action=start.", { action: "start", active: false });
			}

			const active = loop.start(intervalMs, prompt);
			return textResult(`Loop started every ${formatInterval(active.intervalMs)}: ${prompt}`, {
				action: "start",
				active: true,
				intervalMs: active.intervalMs,
				prompt,
			});
		},
	});

	pi.registerCommand("loop", {
		description: "Inject a recurring prompt (/loop <interval> <prompt> | /loop status | /loop stop).",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parsedArgs = parseLoopCommand(args);
			if ("error" in parsedArgs) {
				ctx.ui.notify(parsedArgs.error, "error");
				return;
			}

			if (parsedArgs.action === "status") {
				ctx.ui.notify(describeLoop(loop.status()), "info");
				return;
			}

			if (parsedArgs.action === "stop") {
				ctx.ui.notify(loop.stop() ? "Loop stopped" : "No active loop", "info");
				return;
			}

			if (parsedArgs.action === "start") {
				const active = loop.start(parsedArgs.intervalMs, parsedArgs.prompt);
				ctx.ui.notify(`Loop started every ${formatInterval(active.intervalMs)}`, "info");
				ctx.ui.setEditorText("");
			}
		},
	});
}
