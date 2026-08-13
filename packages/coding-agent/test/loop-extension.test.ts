import { afterEach, describe, expect, it, vi } from "vitest";
import loopExtension from "../extensions/loop/src/index.ts";
import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
	ToolDefinition,
} from "../src/core/extensions/types.ts";

type RegisteredLoopCommand = Omit<RegisteredCommand, "name" | "sourceInfo">;
type AgentEndHandler = (event: AgentEndEvent, ctx: ExtensionContext) => Promise<void> | void;

function createLoopHarness() {
	let command: RegisteredLoopCommand | undefined;
	let tool: ToolDefinition | undefined;
	let agentEndHandler: AgentEndHandler | undefined;
	let idle = true;
	const sessionShutdownHandlers: Array<(event: unknown, ctx: ExtensionContext) => void> = [];
	const notify = vi.fn();
	const sendMessage = vi.fn();
	const sendUserMessage = vi.fn();
	const setEditorText = vi.fn();

	const pi = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
			if (event === "agent_end") {
				agentEndHandler = handler;
			}
			if (event === "session_shutdown") {
				sessionShutdownHandlers.push(handler);
			}
		},
		registerCommand(name: string, options: RegisteredLoopCommand) {
			if (name === "loop") {
				command = options;
			}
		},
		registerTool(definition: ToolDefinition) {
			if (definition.name === "loop") {
				tool = definition;
			}
		},
		sendMessage,
		sendUserMessage,
	} as unknown as ExtensionAPI;

	loopExtension(pi);

	if (!command) throw new Error("loop command was not registered");
	if (!tool) throw new Error("loop tool was not registered");
	const registeredCommand = command;
	const registeredTool = tool;

	const sessionManager = { getSessionId: () => "test-session" };
	const ctx = {
		cwd: "/repo",
		hasPendingMessages: () => false,
		isIdle: () => idle,
		sessionManager,
		ui: { notify, setEditorText },
	} as unknown as ExtensionCommandContext;
	const toolCtx = {
		cwd: "/repo",
		hasPendingMessages: () => false,
		isIdle: () => idle,
		sessionManager,
		ui: { notify },
	} as unknown as ExtensionContext;

	return {
		notify,
		sendMessage,
		sendUserMessage,
		setEditorText,
		setIdle: (value: boolean) => {
			idle = value;
		},
		runAgentEnd: async (messages: AgentEndEvent["messages"] = []) => {
			if (!agentEndHandler) throw new Error("agent_end handler was not registered");
			await agentEndHandler({ type: "agent_end", messages }, ctx);
		},
		runCommand: async (args: string) => registeredCommand.handler(args, ctx),
		runShutdown: () => {
			for (const handler of sessionShutdownHandlers) handler({}, toolCtx);
		},
		runTool: (params: Record<string, unknown>) =>
			registeredTool.execute("loop-call", params, undefined, undefined, toolCtx),
		tool: registeredTool,
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("loop extension", () => {
	it("registers a slash command and a tool", () => {
		const harness = createLoopHarness();

		expect(harness.tool.name).toBe("loop");
		expect(harness.tool.approvalRequired).toBe(true);
	});

	it("injects a prompt at the requested slash-command interval", async () => {
		vi.useFakeTimers();
		const harness = createLoopHarness();

		await harness.runCommand("10s check progress");
		expect(harness.sendUserMessage).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(9_999);
		expect(harness.sendUserMessage).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "loop", content: "check progress", display: true }),
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});

	it("coalesces busy interval ticks into one deferred loop follow-up", async () => {
		vi.useFakeTimers();
		const harness = createLoopHarness();
		const prompt = "check progress";

		harness.setIdle(false);
		await harness.runCommand(`1s ${prompt}`);
		await vi.advanceTimersByTimeAsync(3_000);

		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.sendMessage).not.toHaveBeenCalled();

		harness.setIdle(true);
		await harness.runAgentEnd();

		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.sendMessage).toHaveBeenCalledTimes(1);
		const [message, options] = harness.sendMessage.mock.calls[0] ?? [];
		expect(message).toMatchObject({ customType: "loop", content: prompt, display: true });
		expect(options).toMatchObject({ deliverAs: "followUp" });
	});

	it("stopping a busy loop cancels its deferred follow-up", async () => {
		vi.useFakeTimers();
		const harness = createLoopHarness();

		harness.setIdle(false);
		await harness.runCommand("1s check progress");
		await vi.advanceTimersByTimeAsync(1_000);
		await harness.runCommand("stop");

		harness.setIdle(true);
		await harness.runAgentEnd();

		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.sendMessage).not.toHaveBeenCalled();
	});

	it("replacing a busy loop cancels its previous deferred follow-up", async () => {
		vi.useFakeTimers();
		const harness = createLoopHarness();

		harness.setIdle(false);
		await harness.runCommand("1s old prompt");
		await vi.advanceTimersByTimeAsync(1_000);
		await harness.runCommand("1s new prompt");

		harness.setIdle(true);
		await harness.runAgentEnd();

		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.sendMessage).not.toHaveBeenCalled();
	});

	it("marks loop-origin follow-ups with visible custom-message provenance", async () => {
		vi.useFakeTimers();
		const harness = createLoopHarness();
		const prompt = "check progress";

		harness.setIdle(false);
		await harness.runCommand(`1s ${prompt}`);
		await vi.advanceTimersByTimeAsync(1_000);
		harness.setIdle(true);
		await harness.runAgentEnd();

		expect(harness.sendMessage.mock.calls[0]?.[0]).toMatchObject({
			customType: "loop",
			content: prompt,
			display: true,
		});
	});

	it("stops the active slash-command loop", async () => {
		vi.useFakeTimers();
		const harness = createLoopHarness();

		await harness.runCommand("5s check progress");
		await harness.runCommand("stop");
		await vi.advanceTimersByTimeAsync(5_000);

		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenLastCalledWith("Loop stopped", "info");
	});

	it("starts and stops a loop through the tool", async () => {
		vi.useFakeTimers();
		const harness = createLoopHarness();

		const startResult = await harness.runTool({
			action: "start",
			intervalSeconds: 3,
			prompt: "continue",
		});
		expect(startResult.content[0]?.type).toBe("text");
		const startText = startResult.content.find((item) => item.type === "text")?.text;
		expect(startText).toContain("Loop started");

		await vi.advanceTimersByTimeAsync(3_000);
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.sendMessage).toHaveBeenCalledTimes(1);
		expect(harness.sendMessage.mock.calls[0]?.[0]).toMatchObject({ customType: "loop", content: "continue" });

		await harness.runTool({ action: "stop" });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(harness.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("clears the active timer on session shutdown", async () => {
		vi.useFakeTimers();
		const harness = createLoopHarness();

		await harness.runCommand("2s keep going");
		harness.runShutdown();
		await vi.advanceTimersByTimeAsync(2_000);

		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});
});
