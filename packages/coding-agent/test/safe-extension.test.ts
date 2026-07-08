import { describe, expect, it, vi } from "vitest";
import safeExtension from "../extensions/safe/src/index.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
	ToolCallEvent,
} from "../src/core/extensions/types.ts";

type RegisteredSafeCommand = Omit<RegisteredCommand, "name" | "sourceInfo">;

function toolCall(toolName: string): ToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: `${toolName}-call`,
		toolName,
		input: {},
		bypassPermissions: false,
	};
}

function createSafeHarness() {
	let command: RegisteredSafeCommand | undefined;
	const toolGates: Array<(event: ToolCallEvent, ctx: ExtensionContext) => unknown> = [];
	const notify = vi.fn();
	const setStatus = vi.fn();
	const setEditorText = vi.fn();

	const pi = {
		on() {},
		registerToolGate(gate: (event: ToolCallEvent, ctx: ExtensionContext) => unknown) {
			toolGates.push(gate);
		},
		registerCommand(name: string, options: RegisteredSafeCommand) {
			if (name === "safe") {
				command = options;
			}
		},
	} as unknown as ExtensionAPI;

	safeExtension(pi);

	if (!command) throw new Error("safe command was not registered");
	const registeredCommand = command;
	const ctx = {
		cwd: "/repo",
		ui: { notify, setEditorText, setStatus },
	} as unknown as ExtensionCommandContext;

	return {
		notify,
		setEditorText,
		setStatus,
		getCompletions: (prefix: string) => registeredCommand.getArgumentCompletions?.(prefix),
		runCommand: async (args: string) => registeredCommand.handler(args, ctx),
		runToolCall: async (event: ToolCallEvent) => {
			const results = [];
			for (const gate of toolGates) {
				results.push(await gate(event, ctx));
			}
			return results.at(-1);
		},
	};
}

describe("safe extension", () => {
	it("registers a /safe command with completions", () => {
		const harness = createSafeHarness();

		expect(harness.runCommand).toBeDefined();
		expect(harness.getCompletions("o")).toEqual([
			{ value: "on", label: "on" },
			{ value: "off", label: "off" },
		]);
		expect(harness.getCompletions("s")).toEqual([{ value: "status", label: "status" }]);
	});

	it("blocks non-allowlisted tools while safe mode is enabled", async () => {
		const harness = createSafeHarness();

		await harness.runCommand("on");

		expect(await harness.runToolCall(toolCall("web_search"))).toBeUndefined();
		expect(await harness.runToolCall(toolCall("ask_questions"))).toBeUndefined();
		expect(await harness.runToolCall(toolCall("bash"))).toEqual({
			block: true,
			reason: "Safe mode blocks tool: bash",
		});
		expect(await harness.runToolCall(toolCall("read"))).toEqual({
			block: true,
			reason: "Safe mode blocks tool: read",
		});
		expect(await harness.runToolCall(toolCall("pyrun_eval"))).toEqual({
			block: true,
			reason: "Safe mode blocks tool: pyrun_eval",
		});
		expect(await harness.runToolCall(toolCall("hostrun_eval"))).toEqual({
			block: true,
			reason: "Safe mode blocks tool: hostrun_eval",
		});
		expect(await harness.runToolCall(toolCall("custom_tool"))).toEqual({
			block: true,
			reason: "Safe mode blocks tool: custom_tool",
		});
	});

	it("allows all tools again after safe mode is disabled", async () => {
		const harness = createSafeHarness();

		await harness.runCommand("on");
		await harness.runCommand("off");

		expect(await harness.runToolCall(toolCall("bash"))).toBeUndefined();
		expect(harness.setStatus).toHaveBeenLastCalledWith("safe", undefined);
	});

	it("reports status and rejects invalid arguments", async () => {
		const harness = createSafeHarness();

		await harness.runCommand("status");
		expect(harness.notify).toHaveBeenLastCalledWith("Safe mode is off", "info");

		await harness.runCommand("on");
		expect(harness.notify).toHaveBeenLastCalledWith("Safe mode enabled", "info");
		expect(harness.setStatus).toHaveBeenLastCalledWith("safe", "safe:on");
		expect(harness.setEditorText).toHaveBeenLastCalledWith("");

		await harness.runCommand("bogus");
		expect(harness.notify).toHaveBeenLastCalledWith("Usage: /safe on|off|status", "error");
	});
});
