import { describe, expect, it, vi } from "vitest";
import selfRestartExtension from "../extensions/self-restart/src/index.ts";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
	ToolDefinition,
} from "../src/core/extensions/types.ts";

type RestartSelfTool = {
	name: string;
	execute(
		toolCallId: string,
		params: Record<string, never>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<{ restarted: boolean }>>;
};

function createSelfRestartHarness() {
	let restartCommand: RegisteredCommand | undefined;
	let restartTool: RestartSelfTool | undefined;
	let restartDefinition: ToolDefinition | undefined;

	const pi = {
		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) {
			if (name === "restart") {
				restartCommand = {
					...options,
					name,
					sourceInfo: {
						path: "self-restart-test",
						source: "self-restart-test",
						scope: "temporary",
						origin: "top-level",
					},
				};
			}
		},
		registerTool(tool: ToolDefinition) {
			if (tool.name === "restart_self") {
				restartDefinition = tool;
				restartTool = tool as unknown as RestartSelfTool;
			}
		},
	} as unknown as ExtensionAPI;

	selfRestartExtension(pi);

	if (!restartTool) {
		throw new Error("restart_self was not registered");
	}

	const registeredRestartTool = restartTool;
	const restart = vi.fn(async () => undefined);
	const ctx = {
		restart,
	} as unknown as ExtensionContext;

	return {
		restart,
		commandDefinition: restartCommand,
		runCommand: () => restartCommand?.handler("", ctx as unknown as ExtensionCommandContext),
		toolDefinition: restartDefinition,
		execute: () => registeredRestartTool.execute("restart-self-test-call", {}, undefined, undefined, ctx),
	};
}

describe("self-restart extension", () => {
	it("registers restart as a slash command", async () => {
		const harness = createSelfRestartHarness();

		expect(harness.commandDefinition?.name).toBe("restart");
		expect(harness.commandDefinition?.description?.toLowerCase()).toContain("restart");

		await harness.runCommand();

		expect(harness.restart).toHaveBeenCalledWith({
			notice: "The agent process was restarted by tool request. Continue from the current session.",
			process: true,
		});
	});

	it("registers restart_self as an approval-gated tool", () => {
		const harness = createSelfRestartHarness();

		expect(harness.toolDefinition?.name).toBe("restart_self");
		expect(harness.toolDefinition?.approvalRequired).toBe(true);
		expect(harness.toolDefinition?.description.toLowerCase()).toContain("restart");
	});

	it("restarts the current session and reports completion", async () => {
		const harness = createSelfRestartHarness();

		const result = await harness.execute();

		expect(harness.restart).toHaveBeenCalledWith({
			notice: "The agent process was restarted by tool request. Continue from the current session.",
			process: true,
		});
		expect(result.details).toEqual({ restarted: true });
		expect(result.content[0]).toEqual({ type: "text", text: "Restart requested. Current session was reloaded." });
	});
});
