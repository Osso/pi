import { describe, expect, it, vi } from "vitest";
import effortExtension from "../extensions/effort/src/index.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
} from "../src/core/extensions/types.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

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

function createCommandHarness(options?: {
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
	const pi = {
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
	const setStatus = vi.fn();
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
		ui: { notify, select, setEditorText, setStatus },
		getThinkingLevel: () => thinkingLevel,
		setThinkingLevel: setTargetThinkingLevel,
	} as unknown as ExtensionCommandContext;

	const command = commands.get("effort");
	const multiAgentCommand = commands.get("multi-agent");
	if (!command || !multiAgentCommand) throw new Error("expected effort and multi-agent commands");
	return {
		appendEntry,
		command,
		ctx,
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

	it("persists and restores explicit delegation without retaining proactive policy", async () => {
		const initial = createCommandHarness();
		await initial.multiAgentCommand.handler("explicit", initial.ctx);

		expect(initial.appendEntry).toHaveBeenCalledWith("multi-agent-mode", { mode: "explicit" });
		const beforeAgentStart = initial.handlers.get("before_agent_start")?.[0];
		if (!beforeAgentStart) throw new Error("expected before_agent_start handler");
		const explicitResult = await beforeAgentStart(
			{
				systemPrompt: "base\n\n<multi_agent_mode>Proactive multi-agent delegation is active.</multi_agent_mode>",
			},
			initial.ctx,
		);
		expect(requireSystemPrompt(explicitResult)).toContain("Do not spawn sub-agents unless");
		expect(requireSystemPrompt(explicitResult)).not.toContain("Proactive multi-agent delegation is active.");

		const restored = createCommandHarness({
			branch: [{ type: "custom", customType: "multi-agent-mode", data: { mode: "explicit" } }],
		});
		const sessionStart = restored.handlers.get("session_start")?.[0];
		if (!sessionStart) throw new Error("expected session_start handler");
		await sessionStart({ type: "session_start", reason: "resume" }, restored.ctx);
		const restoredBeforeAgentStart = restored.handlers.get("before_agent_start")?.[0];
		if (!restoredBeforeAgentStart) throw new Error("expected before_agent_start handler");
		const restoredResult = await restoredBeforeAgentStart({ systemPrompt: "base" }, restored.ctx);
		expect(requireSystemPrompt(restoredResult)).toContain("Do not spawn sub-agents unless");
	});

	it("keeps delegation mode when changing a non-ultra effort", async () => {
		const { command, ctx, handlers, multiAgentCommand } = createCommandHarness();
		await multiAgentCommand.handler("explicit", ctx);
		await command.handler("high", ctx);

		const beforeAgentStart = handlers.get("before_agent_start")?.[0];
		if (!beforeAgentStart) throw new Error("expected before_agent_start handler");
		const result = await beforeAgentStart({ systemPrompt: "base" }, ctx);
		expect(requireSystemPrompt(result)).toContain("Do not spawn sub-agents unless");
	});

	it("maps /effort ultra to ultra reasoning and proactive delegation", async () => {
		const { appendEntry, command, ctx, handlers, notify, setTargetThinkingLevel } = createCommandHarness({
			thinkingLevel: "high",
		});

		await command.handler("ultra", ctx);

		expect(setTargetThinkingLevel).toHaveBeenCalledWith("ultra");
		expect(appendEntry).toHaveBeenCalledWith("multi-agent-mode", { mode: "proactive" });
		expect(notify).toHaveBeenCalledWith("Effort: ultra (max + proactive)", "info");
		const beforeAgentStart = handlers.get("before_agent_start")?.[0];
		if (!beforeAgentStart) throw new Error("expected before_agent_start handler");
		const result = await beforeAgentStart({ systemPrompt: "base" }, ctx);
		expect(requireSystemPrompt(result)).toContain("Proactive multi-agent delegation is active.");
	});

	it("enables proactive delegation when the interactive selector chooses ultra", async () => {
		const { appendEntry, ctx, handlers, multiAgentCommand } = createCommandHarness({ thinkingLevel: "max" });
		await multiAgentCommand.handler("explicit", ctx);
		appendEntry.mockClear();

		const thinkingLevelSelect = handlers.get("thinking_level_select")?.[0];
		if (!thinkingLevelSelect) throw new Error("expected thinking_level_select handler");
		await thinkingLevelSelect({ level: "ultra", previousLevel: "max" }, ctx);

		expect(appendEntry).toHaveBeenCalledWith("multi-agent-mode", { mode: "proactive" });
		const beforeAgentStart = handlers.get("before_agent_start")?.[0];
		if (!beforeAgentStart) throw new Error("expected before_agent_start handler");
		const result = await beforeAgentStart({ systemPrompt: "base" }, ctx);
		expect(requireSystemPrompt(result)).toContain("Proactive multi-agent delegation is active.");
	});

	it("keeps maximum reasoning when explicit mode disables an ultra preset", async () => {
		const { ctx, multiAgentCommand, setTargetThinkingLevel } = createCommandHarness({ thinkingLevel: "ultra" });

		await multiAgentCommand.handler("explicit", ctx);

		expect(setTargetThinkingLevel).toHaveBeenCalledWith("max");
	});

	it("lets a main runtime with historical subagent provenance control delegation mode", async () => {
		const { appendEntry, ctx, multiAgentCommand, notify } = createCommandHarness({ subagentProvenance: true });

		await multiAgentCommand.handler("explicit", ctx);

		expect(appendEntry).toHaveBeenCalledWith("multi-agent-mode", { mode: "explicit" });
		expect(notify).toHaveBeenCalledWith("Multi-agent mode: explicit", "info");
	});

	it("does not let child runtimes change delegation mode or receive its policy", async () => {
		const { appendEntry, ctx, handlers, multiAgentCommand, notify } = createCommandHarness({ child: true });

		await multiAgentCommand.handler("explicit", ctx);

		expect(appendEntry).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("Multi-agent mode is controlled by the main thread", "warning");
		const beforeAgentStart = handlers.get("before_agent_start")?.[0];
		if (!beforeAgentStart) throw new Error("expected before_agent_start handler");
		expect(await beforeAgentStart({ systemPrompt: "base" }, ctx)).toBeUndefined();
	});
});
