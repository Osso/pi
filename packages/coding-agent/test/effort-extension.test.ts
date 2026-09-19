import { describe, expect, it, vi } from "vitest";
import effortExtension from "../extensions/effort/src/index.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
} from "../src/core/extensions/types.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

function requireSystemPrompt(result: unknown): string {
	if (
		typeof result !== "object" ||
		result === null ||
		!("systemPrompt" in result) ||
		typeof result.systemPrompt !== "string"
	) {
		throw new Error("expected before_agent_start to return a system prompt");
	}
	return result.systemPrompt;
}

const SUBAGENT_TOOLS = [
	"spawn_agent",
	"list_agents",
	"attach_session_agent",
	"wait_agent",
	"close_agent",
	"steer_agent",
	"agent_viewer",
	"send_agent_message",
	"contact_parent",
];

function createCommandHarness(options?: {
	activeTools?: string[];
	branch?: unknown[];
	child?: boolean;
	reasoning?: boolean;
	subagentProvenance?: boolean;
	selectedEffort?: string | undefined;
	thinkingLevel?: string;
}) {
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	let thinkingLevel = options?.thinkingLevel ?? "off";
	const setThinkingLevel = vi.fn((level: string) => {
		thinkingLevel = level;
	});
	const appendEntry = vi.fn();
	let activeTools = options?.activeTools ?? ["read", "pyrun_eval", "list_sessions", ...SUBAGENT_TOOLS];
	const getActiveTools = () => [...activeTools];
	const setActiveTools = (names: string[]) => {
		activeTools = [...names];
	};
	const pi = {
		getActiveTools,
		setActiveTools,
		getThinkingLevel: () => thinkingLevel,
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand: (name: string, registeredCommand: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			commands.set(name, registeredCommand);
		},
		appendEntry,
		setThinkingLevel,
	} as unknown as ExtensionAPI;

	effortExtension(pi);

	const notify = vi.fn();
	const select = vi.fn().mockResolvedValue(options?.selectedEffort);
	const setEditorText = vi.fn();
	const extensionStatuses = new Map<string, string>();
	const setStatus = vi.fn((key: string, status: string | undefined) => {
		if (status === undefined) extensionStatuses.delete(key);
		else extensionStatuses.set(key, status);
	});
	const setTargetThinkingLevel = vi.fn((level: string) => {
		thinkingLevel = level;
	});
	const sessionManager = {
		getBranch: () => options?.branch ?? [],
		isSubagentSession: () => options?.child === true || options?.subagentProvenance === true,
	};
	const ctx = {
		model: {
			id: "reasoner",
			provider: "test",
			contextWindow: 200_000,
			reasoning: options?.reasoning ?? true,
			thinkingLevelMap: { xhigh: "xhigh", max: "max", ultra: "max" },
		},
		multiAgentAgentId: options?.child ? "child-agent" : undefined,
		sessionManager,
		ui: { notify, select, setEditorText, setStatus, theme },
		getThinkingLevel: () => thinkingLevel,
		setThinkingLevel: setTargetThinkingLevel,
	} as unknown as ExtensionCommandContext;

	const command = commands.get("effort");
	const multiAgentCommand = commands.get("multi-agent");
	if (!command || !multiAgentCommand) throw new Error("expected effort and multi-agent commands");
	return {
		appendEntry,
		getActiveTools,
		setActiveTools,
		command,
		ctx,
		extensionStatuses,
		handlers,
		multiAgentCommand,
		notify,
		select,
		setEditorText,
		setStatus,
		setTargetThinkingLevel,
		setThinkingLevel,
	};
}

describe("effort extension", () => {
	it("keeps /effort out of built-in slash commands", () => {
		expect(BUILTIN_SLASH_COMMANDS.map((command) => command.name)).not.toContain("effort");
	});

	it("registers /effort from the extension", () => {
		const { command } = createCommandHarness();

		expect(command.description).toBe("Set model effort level (depends on selected model)");
	});

	it("opens a selector of supported efforts when no effort is specified", async () => {
		const { command, ctx, notify, select, setEditorText, setTargetThinkingLevel } = createCommandHarness({
			selectedEffort: "high",
		});

		await command.handler("", ctx);

		expect(select).toHaveBeenCalledWith("Select effort", expect.arrayContaining(["off", "high"]));
		expect(setTargetThinkingLevel).toHaveBeenCalledWith("high");
		expect(notify).toHaveBeenCalledWith("Effort: high", "info");
		expect(setEditorText).toHaveBeenCalledWith("");
	});

	it("only offers efforts supported by the current model", async () => {
		const { command, ctx, select, setTargetThinkingLevel } = createCommandHarness({
			reasoning: false,
			selectedEffort: "off",
		});

		await command.handler("", ctx);

		expect(select).toHaveBeenCalledWith("Select effort", ["off"]);
		expect(setTargetThinkingLevel).toHaveBeenCalledWith("off");
	});

	it("does not change effort when the selector is cancelled", async () => {
		const { command, ctx, notify, select, setEditorText, setThinkingLevel } = createCommandHarness();

		await command.handler("", ctx);

		expect(select).toHaveBeenCalledOnce();
		expect(setThinkingLevel).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
		expect(setEditorText).toHaveBeenCalledWith("");
	});

	it("sets a valid model-supported effort", async () => {
		const { command, ctx, notify, setEditorText, setTargetThinkingLevel } = createCommandHarness({
			thinkingLevel: "high",
		});

		await command.handler("high", ctx);

		expect(setTargetThinkingLevel).toHaveBeenCalledWith("high");
		expect(notify).toHaveBeenCalledWith("Effort: high", "info");
		expect(setEditorText).toHaveBeenCalledWith("");
	});

	it("routes /effort through the viewed-session command context without main fallback", async () => {
		const { command, ctx, setTargetThinkingLevel, setThinkingLevel } = createCommandHarness();

		await command.handler("high", ctx);

		expect(setTargetThinkingLevel).toHaveBeenCalledWith("high");
		expect(setThinkingLevel).not.toHaveBeenCalled();
	});

	it("rejects effort levels unsupported by the current model", async () => {
		const { command, ctx, notify, setThinkingLevel } = createCommandHarness({ reasoning: false });

		await command.handler("high", ctx);

		expect(setThinkingLevel).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith('Invalid effort "high". Available: off', "warning");
	});

	it("defaults to proactive delegation and injects an observable policy", async () => {
		const { ctx, handlers } = createCommandHarness();
		const beforeAgentStart = handlers.get("before_agent_start")?.[0];
		if (!beforeAgentStart) throw new Error("expected before_agent_start handler");

		const result = await beforeAgentStart({ systemPrompt: "base" }, ctx);

		expect(result).toMatchObject({
			systemPrompt: expect.stringContaining("Proactive multi-agent delegation is active."),
		});
	});

	it("dims only the multi-agent status prefix", async () => {
		initTheme(undefined, false);
		const { ctx, extensionStatuses, handlers } = createCommandHarness();
		const sessionStart = handlers.get("session_start")?.[0];
		if (!sessionStart) throw new Error("expected session_start handler");

		await sessionStart({ type: "session_start", reason: "new" }, ctx);

		expect(extensionStatuses.get("multi-agent-mode")).toBe(`${theme.fg("dim", "multi-agent: ")}active`);
	});

	it("persists and restores disabled delegation without retaining proactive policy", async () => {
		const initial = createCommandHarness();
		await initial.multiAgentCommand.handler("disabled", initial.ctx);

		expect(initial.appendEntry).toHaveBeenCalledWith("multi-agent-mode", { mode: "disabled" });
		const beforeAgentStart = initial.handlers.get("before_agent_start")?.[0];
		if (!beforeAgentStart) throw new Error("expected before_agent_start handler");
		const disabledResult = await beforeAgentStart(
			{
				systemPrompt: "base\n\n<multi_agent_mode>Proactive multi-agent delegation is active.</multi_agent_mode>",
			},
			initial.ctx,
		);
		expect(requireSystemPrompt(disabledResult)).toBe("base");
		expect(requireSystemPrompt(disabledResult)).not.toContain("Proactive multi-agent delegation is active.");

		const restored = createCommandHarness({
			branch: [{ type: "custom", customType: "multi-agent-mode", data: { mode: "disabled" } }],
		});
		const sessionStart = restored.handlers.get("session_start")?.[0];
		if (!sessionStart) throw new Error("expected session_start handler");
		await sessionStart({ type: "session_start", reason: "resume" }, restored.ctx);
		const restoredBeforeAgentStart = restored.handlers.get("before_agent_start")?.[0];
		if (!restoredBeforeAgentStart) throw new Error("expected before_agent_start handler");
		const restoredResult = await restoredBeforeAgentStart({ systemPrompt: "base" }, restored.ctx);
		expect(requireSystemPrompt(restoredResult)).toBe("base");
	});

	it("hides subagent tools while preserving unrelated tools and disabled status", async () => {
		const harness = createCommandHarness();
		await harness.multiAgentCommand.handler("disabled", harness.ctx);
		expect(harness.getActiveTools()).toEqual(["read", "pyrun_eval", "list_sessions"]);
		expect(harness.extensionStatuses.get("multi-agent-mode")).toBe(`${theme.fg("dim", "multi-agent: ")}disabled`);
	});

	it("restores only previously active subagent tools without reverting unrelated tool selection", async () => {
		const harness = createCommandHarness({ activeTools: ["read", "spawn_agent", "wait_agent"] });
		await harness.multiAgentCommand.handler("disabled", harness.ctx);
		await harness.multiAgentCommand.handler("disabled", harness.ctx);
		harness.setActiveTools(["pyrun_eval", "list_sessions"]);
		await harness.multiAgentCommand.handler("proactive", harness.ctx);
		expect(harness.getActiveTools().sort()).toEqual(
			["pyrun_eval", "list_sessions", "spawn_agent", "wait_agent"].sort(),
		);
		expect(harness.extensionStatuses.get("multi-agent-mode")).toBe(`${theme.fg("dim", "multi-agent: ")}active`);
		expect(harness.appendEntry).toHaveBeenLastCalledWith("multi-agent-mode", { mode: "proactive" });
	});

	it.each(["session_start", "session_tree"])("restores disabled tool selection on %s", async (eventName) => {
		const harness = createCommandHarness({
			branch: [{ type: "custom", customType: "multi-agent-mode", data: { mode: "disabled" } }],
		});
		const handler = harness.handlers.get(eventName)?.[0];
		if (!handler) throw new Error(`expected ${eventName} handler`);
		await handler({ type: eventName, reason: "resume" }, harness.ctx);
		expect(harness.getActiveTools()).toEqual(["read", "pyrun_eval", "list_sessions"]);
		expect(harness.extensionStatuses.get("multi-agent-mode")).toBe(`${theme.fg("dim", "multi-agent: ")}disabled`);
	});

	it("displays active and disabled choices", async () => {
		const harness = createCommandHarness({ selectedEffort: "disabled" });
		await harness.multiAgentCommand.handler("", harness.ctx);
		expect(harness.select).toHaveBeenCalledWith("Select multi-agent mode", ["active", "disabled"]);
		expect(harness.getActiveTools()).toEqual(["read", "pyrun_eval", "list_sessions"]);
	});

	it("maps the active selector label to proactive mode", async () => {
		const harness = createCommandHarness({ selectedEffort: "active" });
		await harness.multiAgentCommand.handler("disabled", harness.ctx);
		await harness.multiAgentCommand.handler("", harness.ctx);
		expect(harness.appendEntry).toHaveBeenLastCalledWith("multi-agent-mode", { mode: "proactive" });
		expect(harness.getActiveTools()).toEqual(expect.arrayContaining(SUBAGENT_TOOLS));
	});

	it("keeps delegation mode when changing a non-ultra effort", async () => {
		const { command, ctx, handlers, multiAgentCommand } = createCommandHarness();
		await multiAgentCommand.handler("disabled", ctx);
		await command.handler("high", ctx);

		const beforeAgentStart = handlers.get("before_agent_start")?.[0];
		if (!beforeAgentStart) throw new Error("expected before_agent_start handler");
		const result = await beforeAgentStart({ systemPrompt: "base" }, ctx);
		expect(requireSystemPrompt(result)).toBe("base");
	});

	it("maps /effort ultra to ultra reasoning and proactive delegation", async () => {
		const { appendEntry, command, ctx, handlers, notify, setTargetThinkingLevel, multiAgentCommand, getActiveTools } =
			createCommandHarness({
				thinkingLevel: "high",
			});

		await multiAgentCommand.handler("disabled", ctx);
		await command.handler("ultra", ctx);
		expect(getActiveTools()).toEqual(expect.arrayContaining(SUBAGENT_TOOLS));

		expect(setTargetThinkingLevel).toHaveBeenCalledWith("ultra");
		expect(appendEntry).toHaveBeenCalledWith("multi-agent-mode", { mode: "proactive" });
		expect(notify).toHaveBeenCalledWith("Effort: ultra (max + active)", "info");
		const beforeAgentStart = handlers.get("before_agent_start")?.[0];
		if (!beforeAgentStart) throw new Error("expected before_agent_start handler");
		const result = await beforeAgentStart({ systemPrompt: "base" }, ctx);
		expect(requireSystemPrompt(result)).toContain("Proactive multi-agent delegation is active.");
	});

	it("enables proactive delegation when the interactive selector chooses ultra", async () => {
		const { appendEntry, ctx, handlers, multiAgentCommand, getActiveTools } = createCommandHarness({
			thinkingLevel: "max",
		});
		await multiAgentCommand.handler("disabled", ctx);
		appendEntry.mockClear();

		const thinkingLevelSelect = handlers.get("thinking_level_select")?.[0];
		if (!thinkingLevelSelect) throw new Error("expected thinking_level_select handler");
		await thinkingLevelSelect({ level: "ultra", previousLevel: "max" }, ctx);
		expect(getActiveTools()).toEqual(expect.arrayContaining(SUBAGENT_TOOLS));

		expect(appendEntry).toHaveBeenCalledWith("multi-agent-mode", { mode: "proactive" });
		const beforeAgentStart = handlers.get("before_agent_start")?.[0];
		if (!beforeAgentStart) throw new Error("expected before_agent_start handler");
		const result = await beforeAgentStart({ systemPrompt: "base" }, ctx);
		expect(requireSystemPrompt(result)).toContain("Proactive multi-agent delegation is active.");
	});

	it("keeps maximum reasoning when disabled mode disables an ultra preset", async () => {
		const { ctx, multiAgentCommand, setTargetThinkingLevel } = createCommandHarness({ thinkingLevel: "ultra" });

		await multiAgentCommand.handler("disabled", ctx);

		expect(setTargetThinkingLevel).toHaveBeenCalledWith("max");
	});
});

describe("effort runtime authorization", () => {
	it("lets a main runtime with historical subagent provenance control delegation mode", async () => {
		const { appendEntry, ctx, multiAgentCommand, notify } = createCommandHarness({ subagentProvenance: true });

		await multiAgentCommand.handler("disabled", ctx);

		expect(appendEntry).toHaveBeenCalledWith("multi-agent-mode", { mode: "disabled" });
		expect(notify).toHaveBeenCalledWith("Multi-agent mode: disabled", "info");
	});

	it("does not let child runtimes change delegation mode or receive its policy", async () => {
		const { appendEntry, ctx, handlers, multiAgentCommand, notify } = createCommandHarness({ child: true });

		await multiAgentCommand.handler("disabled", ctx);

		expect(appendEntry).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("Multi-agent mode is controlled by the main thread", "warning");
		const beforeAgentStart = handlers.get("before_agent_start")?.[0];
		if (!beforeAgentStart) throw new Error("expected before_agent_start handler");
		expect(await beforeAgentStart({ systemPrompt: "base" }, ctx)).toBeUndefined();
	});
});
