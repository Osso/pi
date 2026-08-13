import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const intervalPattern = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/;
const minimumIntervalMs = 1_000;
const loopMessageType = "loop";

type LoopAction = "start" | "stop" | "status";
type LoopRuntimeContext = Pick<ExtensionContext, "hasPendingMessages" | "isIdle" | "sessionManager">;

interface ActiveLoop {
	deferred: boolean;
	generation: number;
	inFlight: boolean;
	intervalMs: number;
	prompt: string;
	sessionId: string;
	timer: ReturnType<typeof setInterval>;
}

interface LoopMessageDetails {
	generation: number;
	sessionId: string;
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

class LoopController {
	private activeLoop: ActiveLoop | undefined;
	private nextGeneration = 0;
	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	start(intervalMs: number, prompt: string, ctx: LoopRuntimeContext): ActiveLoop {
		this.stop();
		const generation = ++this.nextGeneration;
		const sessionId = ctx.sessionManager.getSessionId();
		const timer = setInterval(() => this.handleInterval(generation, ctx), intervalMs);
		this.activeLoop = {
			deferred: false,
			generation,
			inFlight: false,
			intervalMs,
			prompt,
			sessionId,
			timer,
		};
		return this.activeLoop;
	}

	stop(): boolean {
		if (!this.activeLoop) return false;
		clearInterval(this.activeLoop.timer);
		this.activeLoop = undefined;
		return true;
	}

	status(): ActiveLoop | undefined {
		return this.activeLoop;
	}

	handleAgentEnd(messages: AgentMessage[], ctx: LoopRuntimeContext): void {
		const loop = this.activeLoop;
		if (!loop || loop.sessionId !== ctx.sessionManager.getSessionId()) return;
		if (this.includesLoopPrompt(messages, loop)) loop.inFlight = false;
		if (!loop.deferred) return;
		if (loop.inFlight) return;
		if (ctx.hasPendingMessages()) return;
		this.sendLoopPrompt(loop);
	}

	private currentLoop(generation: number, ctx: LoopRuntimeContext): ActiveLoop | undefined {
		if (this.activeLoop?.generation !== generation) return undefined;
		return this.activeLoop.sessionId === ctx.sessionManager.getSessionId() ? this.activeLoop : undefined;
	}

	private handleInterval(generation: number, ctx: LoopRuntimeContext): void {
		const loop = this.currentLoop(generation, ctx);
		if (!loop || loop.inFlight) return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) {
			loop.deferred = true;
			return;
		}
		this.sendLoopPrompt(loop);
	}

	private includesLoopPrompt(messages: AgentMessage[], loop: ActiveLoop): boolean {
		return messages.some((message) => {
			if (message.role !== "custom" || message.customType !== loopMessageType) return false;
			const details = message.details as Partial<LoopMessageDetails> | undefined;
			return details?.generation === loop.generation && details.sessionId === loop.sessionId;
		});
	}

	private sendLoopPrompt(loop: ActiveLoop): void {
		loop.deferred = false;
		loop.inFlight = true;
		this.pi.sendMessage(
			{
				customType: loopMessageType,
				content: loop.prompt,
				display: true,
				details: { generation: loop.generation, sessionId: loop.sessionId } satisfies LoopMessageDetails,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}
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
	const loop = new LoopController(pi);

	pi.on("session_shutdown", () => {
		loop.stop();
	});
	pi.on("agent_end", (event, ctx) => {
		if (event.sessionContinuation) return;
		loop.handleAgentEnd(event.messages, ctx);
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

			const active = loop.start(intervalMs, prompt, _ctx);
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
				const active = loop.start(parsedArgs.intervalMs, parsedArgs.prompt, ctx);
				ctx.ui.notify(`Loop started every ${formatInterval(active.intervalMs)}`, "info");
				ctx.ui.setEditorText("");
			}
		},
	});
}
