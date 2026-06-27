import { afterEach, describe, expect, it, vi } from "vitest";
import loopExtension from "../extensions/loop/src/index.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
	ToolDefinition,
} from "../src/core/extensions/types.ts";

type RegisteredLoopCommand = Omit<RegisteredCommand, "name" | "sourceInfo">;

function createLoopHarness() {
	let command: RegisteredLoopCommand | undefined;
	let tool: ToolDefinition | undefined;
	const sessionShutdownHandlers: Array<(event: unknown, ctx: ExtensionContext) => void> = [];
	const notify = vi.fn();
	const sendUserMessage = vi.fn();
	const setEditorText = vi.fn();

	const pi = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
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
		sendUserMessage,
	} as unknown as ExtensionAPI;

	loopExtension(pi);

	if (!command) throw new Error("loop command was not registered");
	if (!tool) throw new Error("loop tool was not registered");
	const registeredCommand = command;
	const registeredTool = tool;

	const ctx = { cwd: "/repo", ui: { notify, setEditorText } } as unknown as ExtensionCommandContext;
	const toolCtx = { cwd: "/repo", ui: { notify } } as unknown as ExtensionContext;

	return {
		notify,
		sendUserMessage,
		setEditorText,
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
		expect(harness.sendUserMessage).toHaveBeenCalledWith("check progress", { deliverAs: "followUp" });
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
		expect(harness.sendUserMessage).toHaveBeenCalledWith("continue", { deliverAs: "followUp" });

		await harness.runTool({ action: "stop" });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
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
