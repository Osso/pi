import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as DesktopNotificationModule from "../../src/core/desktop-notification.ts";

const desktopNotifier = vi.hoisted(() => vi.fn());

vi.mock("../../src/core/desktop-notification.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof DesktopNotificationModule>();
	return {
		...actual,
		sendDesktopNotification: desktopNotifier,
	};
});

import claudeBashHookExtension from "../../extensions/claude-bash-hook/src/index.ts";
import hostrunExtension from "../../extensions/hostrun/src/index.ts";
import safeExtension from "../../extensions/safe/src/index.ts";
import {
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionUIContext,
	isToolCallEventType,
	type ToolCallEvent,
	type ToolDefinition,
} from "../../src/index.ts";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession model and extension characterization", () => {
	const harnesses: Harness[] = [];
	const hookScriptDirs: string[] = [];
	const originalClaudeBashHook = process.env.PI_CLAUDE_BASH_HOOK;

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (hookScriptDirs.length > 0) {
			rmSync(hookScriptDirs.pop()!, { force: true, recursive: true });
		}
		desktopNotifier.mockReset();
		if (originalClaudeBashHook === undefined) {
			delete process.env.PI_CLAUDE_BASH_HOOK;
		} else {
			process.env.PI_CLAUDE_BASH_HOOK = originalClaudeBashHook;
		}
	});

	function createConfirmUiContext(
		confirm: ExtensionUIContext["confirm"],
		select: ExtensionUIContext["select"] = async () => undefined,
	): ExtensionUIContext {
		return {
			addAutocompleteProvider: () => {},
			confirm,
			custom: async () => undefined as never,
			editor: async () => undefined,
			getAllThemes: () => [],
			getEditorComponent: () => undefined,
			getEditorText: () => "",
			getTheme: () => undefined,
			getToolsExpanded: () => false,
			input: async () => undefined,
			notify: () => {},
			onTerminalInput: () => () => {},
			pasteToEditor: () => {},
			select,
			setEditorComponent: () => {},
			setEditorText: () => {},
			setFooter: () => {},
			setDefaultFooter: () => {},
			setHeader: () => {},
			setHiddenThinkingLabel: () => {},
			setStatus: () => {},
			setTheme: () => ({ success: false, error: "not available in tests" }),
			setTitle: () => {},
			setToolsExpanded: () => {},
			setWidget: () => {},
			setWorkingIndicator: () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			theme: {} as ExtensionUIContext["theme"],
		};
	}

	function useFakeClaudeBashHook(hookSpecificOutput: Record<string, unknown>): void {
		const scriptDir = join(tmpdir(), `pi-claude-bash-hook-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const scriptPath = join(scriptDir, "claude-bash-hook");
		hookScriptDirs.push(scriptDir);
		mkdirSync(scriptDir, { recursive: true });
		writeFileSync(
			scriptPath,
			[
				"#!/usr/bin/env node",
				"let input = '';",
				"process.stdin.on('data', (chunk) => { input += chunk; });",
				"process.stdin.on('end', () => {",
				"  const parsed = JSON.parse(input);",
				"  if (parsed.tool_name !== 'Bash') process.exit(3);",
				`  console.log(${JSON.stringify(JSON.stringify({ hookSpecificOutput }))});`,
				"});",
				"",
			].join("\n"),
		);
		chmodSync(scriptPath, 0o755);
		process.env.PI_CLAUDE_BASH_HOOK = scriptPath;
	}

	it("narrows built-in and custom tool_call inputs with isToolCallEventType", () => {
		const bashEvent: ToolCallEvent = {
			type: "tool_call",
			toolCallId: "tool-call-1",
			toolName: "bash",
			bypassPermissions: false,
			input: { command: "pwd" },
		};
		const customEvent: ToolCallEvent = {
			type: "tool_call",
			toolCallId: "tool-call-2",
			toolName: "custom_tool",
			bypassPermissions: false,
			input: { action: "inspect" },
		};

		let command: string | undefined;
		if (isToolCallEventType("bash", bashEvent)) {
			command = bashEvent.input.command;
		}
		let action: string | undefined;
		if (isToolCallEventType<"custom_tool", { action: string }>("custom_tool", customEvent)) {
			action = customEvent.input.action;
		}

		expect(command).toBe("pwd");
		expect(action).toBe("inspect");
		expect(isToolCallEventType("read", bashEvent)).toBe(false);
	});

	it("setModel saves the model and emits model_select", async () => {
		const modelEvents: string[] = [];
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async (event) => {
						modelEvents.push(`${event.previousModel?.id ?? "none"}->${event.model.id}:${event.source}`);
					});
				},
			],
		});
		harnesses.push(harness);
		const nextModel = harness.getModel("faux-2")!;

		await harness.session.setModel(nextModel);

		expect(harness.session.model?.id).toBe("faux-2");
		expect(modelEvents).toEqual(["faux-1->faux-2:set"]);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "model_change")
				.map((entry) => `${entry.provider}/${entry.modelId}`),
		).toEqual([`${nextModel.provider}/${nextModel.id}`]);
	});

	it("cycles through scoped models and preserves the scoped thinking preference", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: false },
			],
		});
		harnesses.push(harness);
		const modelOne = harness.getModel("faux-1")!;
		const modelTwo = harness.getModel("faux-2")!;
		harness.session.setScopedModels([{ model: modelOne, thinkingLevel: "high" }, { model: modelTwo }] as Array<{
			model: Model<string>;
			thinkingLevel?: ThinkingLevel;
		}>);
		harness.session.setThinkingLevel("high");

		await harness.session.cycleModel();
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.session.thinkingLevel).toBe("off");

		await harness.session.cycleModel();
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.session.thinkingLevel).toBe("high");
	});

	it("cycles only the persisted enabled model scope and never all enabled models", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
				{ id: "faux-3", name: "Three", reasoning: true },
			],
			settings: { enabledModels: ["faux-1", "faux-2"] },
		});
		harnesses.push(harness);

		await harness.session.cycleModel();
		expect(harness.session.model?.id).toBe("faux-2");

		await harness.session.cycleModel();
		expect(harness.session.model?.id).toBe("faux-1");

		const allAvailableModelIds = (await harness.session.modelRegistry.getAvailable()).map(
			(model) => `${model.provider}/${model.id}`,
		);
		harness.settingsManager.setEnabledModels(allAvailableModelIds);
		const result = await harness.session.cycleModel();

		expect(result).toBeUndefined();
		expect(harness.session.model?.id).toBe("faux-1");
	});

	it("clamps thinking levels to model capabilities and cycles available levels", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", reasoning: false }] });
		harnesses.push(harness);

		harness.session.setThinkingLevel("high");
		expect(harness.session.thinkingLevel).toBe("off");
		expect(harness.session.cycleThinkingLevel()).toBeUndefined();
	});

	it("throws when setModel is called without configured auth", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			withConfiguredAuth: false,
		});
		harnesses.push(harness);

		await expect(harness.session.setModel(harness.getModel("faux-2")!)).rejects.toThrow(
			`No API key for ${harness.getModel().provider}/faux-2`,
		);
	});

	it("allows extension tool_call handlers to block tool execution", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				throw new Error("tool should have been blocked");
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async () => ({ block: true, reason: "Blocked by test" }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				const errorText =
					toolResult?.role === "toolResult"
						? toolResult.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage(errorText);
			},
		]);

		await harness.session.prompt("hi");

		expect(getAssistantTexts(harness)).toContain("Blocked by test");
		expect(
			harness.session.messages.find((message) => message.role === "toolResult" && message.isError),
		).toBeDefined();
	});

	it("dispatches in-place tool_call input rewrites to the tool and later handlers", async () => {
		const observedInputs: Record<string, unknown>[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text }], details: { text } };
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async (event) => {
						observedInputs.push(event.input);
						if (isToolCallEventType<"echo", Record<string, unknown> & { text: unknown }>("echo", event)) {
							event.input.text = "rewritten";
						}
					});
					pi.on("tool_call", async (event) => {
						observedInputs.push(event.input);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "original" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "");
			},
		]);

		await harness.session.prompt("hi");

		expect(observedInputs).toHaveLength(2);
		expect(observedInputs[0]).toBe(observedInputs[1]);
		expect(observedInputs[1]).toMatchObject({ text: "rewritten" });
		expect(getAssistantTexts(harness)).toContain("rewritten");
	});

	it("does not re-validate tool_call input after an in-place rewrite", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? params.text : undefined;
				return { content: [{ type: "text", text: `type:${typeof text}` }], details: { text } };
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async (event) => {
						if (isToolCallEventType<"echo", Record<string, unknown> & { text: unknown }>("echo", event)) {
							event.input.text = 123;
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "original" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "");
			},
		]);

		await harness.session.prompt("hi");

		expect(getAssistantTexts(harness)).toContain("type:number");
	});

	it("short-circuits later tool_call handlers after a block result", async () => {
		let laterHandlerCalls = 0;
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				throw new Error("tool should have been blocked");
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async () => ({ block: true, reason: "first handler blocked" }));
					pi.on("tool_call", async () => {
						laterHandlerCalls++;
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "");
			},
		]);

		await harness.session.prompt("hi");

		expect(laterHandlerCalls).toBe(0);
		expect(getAssistantTexts(harness)).toContain("first handler blocked");
	});

	it("blocks non-allowlisted tools before auto-approve can execute them", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				throw new Error("tool should have been blocked");
			},
		};
		const harness = await createHarness({
			settings: { approvalPolicy: "auto-approve", approvalPreset: "auto-approve" },
			tools: [echoTool],
			extensionFactories: [safeExtension],
			uiContext: createConfirmUiContext(vi.fn()),
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "");
			},
		]);

		await harness.session.prompt("/safe on");
		await harness.session.prompt("hi");

		expect(getAssistantTexts(harness)).toContain("Safe mode blocks tool: echo");
	});

	it("blocks non-allowlisted tools that opt out of approval", async () => {
		const echoTool: ToolDefinition = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			approvalRequired: false,
			execute: async () => {
				throw new Error("tool should have been blocked");
			},
		};
		const harness = await createHarness({
			settings: { approvalPolicy: "never", approvalPreset: "never-ask-deny" },
			extensionFactories: [safeExtension, (pi) => pi.registerTool(echoTool)],
			uiContext: createConfirmUiContext(vi.fn()),
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "");
			},
		]);

		await harness.session.prompt("/safe on");
		await harness.session.prompt("hi");

		expect(getAssistantTexts(harness)).toContain("Safe mode blocks tool: echo");
	});

	it("blocks non-allowlisted tools before approval reviewers can allow them", async () => {
		useFakeClaudeBashHook({
			permissionDecision: "allow",
			permissionDecisionReason: "safe",
			updatedInput: { command: "printf hook-approved" },
		});
		const harness = await createHarness({
			settings: { approvalPolicy: "on-request", approvalPreset: "ask-me" },
			extensionFactories: [claudeBashHookExtension, safeExtension],
			uiContext: createConfirmUiContext(vi.fn(async () => false)),
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "printf original" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "");
			},
		]);

		await harness.session.prompt("/safe on");
		await harness.session.prompt("hi");

		expect(getAssistantTexts(harness)).toContain("Safe mode blocks tool: bash");
		expect(getAssistantTexts(harness)).not.toContain("hook-approved");
	});

	it("blocks execution when a tool_call handler throws a non-Error value", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				throw new Error("tool should have been blocked");
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async () => {
						throw "non-error failure";
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "");
			},
		]);

		await harness.session.prompt("hi");

		expect(getAssistantTexts(harness)).toContain("Extension failed, blocking execution: non-error failure");
	});

	it("allows on-request tool calls when the human approval dialog allows once", async () => {
		const confirm = vi.fn(async () => false);
		const select = vi.fn(async () => "Allow once");
		let toolExecutions = 0;
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				toolExecutions++;
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text }], details: { text } };
			},
		};
		const harness = await createHarness({
			settings: { approvalPolicy: "on-request", approvalPreset: "ask-me" },
			tools: [echoTool],
			uiContext: createConfirmUiContext(confirm, select),
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "");
			},
		]);

		await harness.session.prompt("hi");

		expect(select).toHaveBeenCalledTimes(1);
		expect(confirm).not.toHaveBeenCalled();
		expect(toolExecutions).toBe(1);
		expect(getAssistantTexts(harness)).toContain("hello");
	});

	it("spawns a background permission agent when the human approval dialog allows always", async () => {
		const confirm = vi.fn(async () => false);
		const select = vi.fn(async () => "Allow always");
		const spawnedPrompts: string[] = [];
		let toolExecutions = 0;
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				toolExecutions++;
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text }], details: { text } };
			},
		};
		const spawnAgentTool: AgentTool = {
			name: "spawn_agent",
			label: "Spawn Agent",
			description: "Spawn a background agent",
			parameters: Type.Object({ prompt: Type.String() }),
			execute: async (_toolCallId, params) => {
				const prompt =
					typeof params === "object" && params !== null && "prompt" in params ? String(params.prompt) : "";
				spawnedPrompts.push(prompt);
				return { content: [{ type: "text", text: "spawned" }], details: { prompt } };
			},
		};
		const harness = await createHarness({
			settings: { approvalPolicy: "on-request", approvalPreset: "ask-me" },
			tools: [echoTool, spawnAgentTool],
			uiContext: createConfirmUiContext(confirm, select),
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "");
			},
		]);

		await harness.session.prompt("hi");

		expect(select).toHaveBeenCalledTimes(1);
		expect(confirm).not.toHaveBeenCalled();
		expect(toolExecutions).toBe(1);
		expect(spawnedPrompts).toHaveLength(1);
		expect(spawnedPrompts[0]).toContain("/syncthing/Sync/Projects/claude/claude-bash-hook");
		expect(spawnedPrompts[0]).toContain('"text": "hello"');
		expect(getAssistantTexts(harness)).toContain("hello");
	});

	it("blocks on-request tool calls when the human approval dialog rejects", async () => {
		const confirm = vi.fn(async () => false);
		const select = vi.fn(async () => "Deny");
		let toolExecutions = 0;
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				toolExecutions++;
				throw new Error("tool should have been blocked");
			},
		};
		const harness = await createHarness({
			settings: { approvalPolicy: "on-request", approvalPreset: "ask-me" },
			tools: [echoTool],
			uiContext: createConfirmUiContext(confirm, select),
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "");
			},
		]);

		await harness.session.prompt("hi");

		expect(select).toHaveBeenCalledTimes(1);
		expect(confirm).not.toHaveBeenCalled();
		expect(toolExecutions).toBe(0);
		expect(
			harness.session.messages.find((message) => message.role === "toolResult" && message.isError),
		).toBeDefined();
	});

	it("asks for wrapper approval before delegating hostrun_eval to the canonical adapter", async () => {
		const confirm = vi.fn(async () => false);
		const select = vi.fn(async () => "Deny");
		const harness = await createHarness({
			extensionFactories: [hostrunExtension],
			settings: { approvalPolicy: "on-request", approvalPreset: "ask-me" },
			uiContext: createConfirmUiContext(confirm, select),
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("hostrun_eval", { code: "1 + 1" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "");
			},
		]);

		await harness.session.prompt("hi");

		expect(select).toHaveBeenCalledTimes(1);
		expect(select).toHaveBeenCalledWith(expect.stringContaining("Approve hostrun_eval?"), [
			"Allow once",
			"Allow always",
			"Deny",
		]);
		expect(confirm).not.toHaveBeenCalled();
		expect(
			harness.session.messages.find((message) => message.role === "toolResult" && message.isError),
		).toBeDefined();
	});

	it("preserves baseline tool_call review with bypassPermissions=false under on-request", async () => {
		const hookEvents: Array<{ bypassPermissions?: boolean; toolName: string }> = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				throw new Error("tool should have been blocked");
			},
		};
		const harness = await createHarness({
			settings: { approvalPolicy: "on-request", approvalPreset: "ask-me" },
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async (event) => {
						hookEvents.push({
							bypassPermissions: (event as { bypassPermissions?: boolean }).bypassPermissions,
							toolName: event.toolName,
						});
						return { block: true, reason: "Blocked by baseline hook" };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "");
			},
		]);

		await harness.session.prompt("hi");

		expect(hookEvents).toEqual([{ bypassPermissions: false, toolName: "echo" }]);
		expect(getAssistantTexts(harness)).toContain("Blocked by baseline hook");
	});

	it("blocks tool calls under never approval policy without running hook reviewers", async () => {
		let hookCalls = 0;
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				throw new Error("tool should have been blocked");
			},
		};
		const harness = await createHarness({
			settings: { approvalPolicy: "never" },
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async () => {
						hookCalls++;
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "");
			},
		]);

		await harness.session.prompt("hi");

		expect(hookCalls).toBe(0);
		expect(getAssistantTexts(harness)).toContain("Blocked by approval policy: never");
	});

	it("runs tool calls under auto-approve policy without running hook reviewers", async () => {
		let hookCalls = 0;
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text }], details: { text } };
			},
		};
		const harness = await createHarness({
			settings: { approvalPolicy: "auto-approve" },
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async () => {
						hookCalls++;
						return { block: true, reason: "hook should have been skipped" };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "");
			},
		]);

		await harness.session.prompt("hi");

		expect(hookCalls).toBe(0);
		expect(getAssistantTexts(harness)).toContain("hello");
	});

	it("routes bash approvals through claude-bash-hook and skips native approval when allowed", async () => {
		useFakeClaudeBashHook({
			permissionDecision: "allow",
			permissionDecisionReason: "safe",
			updatedInput: { command: "printf hook-approved" },
		});
		const confirm = vi.fn<ExtensionUIContext["confirm"]>().mockResolvedValue(false);
		const harness = await createHarness({
			extensionFactories: [claudeBashHookExtension],
			uiContext: createConfirmUiContext(confirm),
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "printf original" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "");
			},
		]);

		await harness.session.prompt("hi");

		expect(confirm).not.toHaveBeenCalled();
		expect(getAssistantTexts(harness)).toContain("hook-approved");
	});

	it("applies claude-bash-hook updatedInput before auto-approve executes bash", async () => {
		useFakeClaudeBashHook({
			permissionDecision: "allow",
			permissionDecisionReason: "safe",
			updatedInput: { command: "printf auto-rewritten" },
		});
		const confirm = vi.fn<ExtensionUIContext["confirm"]>().mockResolvedValue(false);
		const harness = await createHarness({
			extensionFactories: [claudeBashHookExtension],
			settings: { approvalPolicy: "auto-approve" },
			uiContext: createConfirmUiContext(confirm),
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "printf original" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "");
			},
		]);

		await harness.session.prompt("hi");

		expect(confirm).not.toHaveBeenCalled();
		expect(getAssistantTexts(harness)).toContain("auto-rewritten");
	});

	it("falls back to native approval when claude-bash-hook asks", async () => {
		useFakeClaudeBashHook({
			permissionDecision: "ask",
			permissionDecisionReason: "needs human review",
		});
		const confirm = vi.fn<ExtensionUIContext["confirm"]>().mockResolvedValue(false);
		const select = vi.fn<ExtensionUIContext["select"]>().mockResolvedValue("Allow once");
		const harness = await createHarness({
			extensionFactories: [claudeBashHookExtension],
			uiContext: createConfirmUiContext(confirm, select),
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "printf native-approved" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "");
			},
		]);

		await harness.session.prompt("hi");

		expect(select).toHaveBeenCalledTimes(1);
		expect(confirm).not.toHaveBeenCalled();
		expect(getAssistantTexts(harness)).toContain("native-approved");
	});

	it("blocks tool calls denied by the LLM-approved reviewer", async () => {
		let toolExecutions = 0;
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				toolExecutions++;
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text }], details: { text } };
			},
		};
		const harness = await createHarness({
			settings: { approvalPolicy: "on-request", approvalPreset: "llm-approved" },
			tools: [echoTool],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage('{"behavior":"deny","message":"llm denied"}'),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "");
			},
		]);

		await harness.session.prompt("hi");

		expect(toolExecutions).toBe(0);
		expect(getAssistantTexts(harness)).toContain("llm denied");
	});

	it("skips the LLM-approved reviewer when a cached permission rule allows", async () => {
		let autoReviewerCalls = 0;
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text }], details: { text } };
			},
		};
		const harness = await createHarness({
			settings: {
				approvalPolicy: "on-request",
				approvalPreset: "llm-approved",
				permissionPromptTool: "mcp__approval__prompt",
				permissionRules: { allow: { echo: ['{"text":"hello"}'] } },
			},
			tools: [echoTool],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				if (!toolResult) {
					autoReviewerCalls++;
					return fauxAssistantMessage('{"behavior":"deny","message":"llm should have been skipped"}');
				}
				return fauxAssistantMessage(getMessageText(toolResult));
			},
		]);

		await harness.session.prompt("hi");

		expect(autoReviewerCalls).toBe(0);
		expect(getAssistantTexts(harness)).toContain("hello");
	});

	it("skips the LLM-approved reviewer when never policy blocks explicitly", async () => {
		let autoReviewerCalls = 0;
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				throw new Error("tool should have been blocked");
			},
		};
		const harness = await createHarness({
			settings: { approvalPolicy: "never", approvalPreset: "llm-approved" },
			tools: [echoTool],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				if (!toolResult) {
					autoReviewerCalls++;
					return fauxAssistantMessage('{"behavior":"allow"}');
				}
				return fauxAssistantMessage(getMessageText(toolResult));
			},
		]);

		await harness.session.prompt("hi");

		expect(autoReviewerCalls).toBe(0);
		expect(getAssistantTexts(harness)).toContain("Blocked by approval policy: never");
	});

	it("skips the LLM-approved reviewer when auto-approve policy allows explicitly", async () => {
		let autoReviewerCalls = 0;
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text }], details: { text } };
			},
		};
		const harness = await createHarness({
			settings: { approvalPolicy: "auto-approve", approvalPreset: "llm-approved" },
			tools: [echoTool],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				if (!toolResult) {
					autoReviewerCalls++;
					return fauxAssistantMessage('{"behavior":"deny","message":"llm should have been skipped"}');
				}
				return fauxAssistantMessage(getMessageText(toolResult));
			},
		]);

		await harness.session.prompt("hi");

		expect(autoReviewerCalls).toBe(0);
		expect(getAssistantTexts(harness)).toContain("hello");
	});

	it("runs configured permission prompt tool before executing tool calls", async () => {
		const approvalInputs: unknown[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return {
					content: [{ type: "text", text }],
					details: { text },
				};
			},
		};
		const approvalTool: AgentTool = {
			name: "mcp__approval__prompt",
			label: "Approval",
			description: "Approve tool calls",
			parameters: Type.Object({
				tool_name: Type.String(),
				input: Type.Any(),
				tool_use_id: Type.String(),
				cwd: Type.String(),
			}),
			execute: async (_toolCallId, params) => {
				approvalInputs.push(params);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ behavior: "allow", updatedInput: { text: "approved" } }),
						},
					],
					details: undefined,
				};
			},
		};
		const harness = await createHarness({
			settings: { permissionPromptTool: "mcp__approval__prompt" },
			tools: [echoTool, approvalTool],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "original" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "");
			},
		]);

		await harness.session.prompt("hi");

		expect(approvalInputs).toMatchObject([
			{
				input: { text: "original" },
				tool_name: "echo",
			},
		]);
		expect(desktopNotifier).toHaveBeenCalledWith({
			body: expect.stringMatching(/^Permission approval needed for echo in .*\.$/),
			title: "Pi permission approval needed",
		});
		expect(getAssistantTexts(harness)).toContain("approved");
	});

	it("uses a single loaded permission prompt protocol tool without explicit config", async () => {
		const approvalInputs: unknown[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return {
					content: [{ type: "text", text }],
					details: { text },
				};
			},
		};
		const approvalTool: AgentTool = {
			name: "mcp__project-approval__approval_prompt",
			label: "Approval",
			description: "Approve tool calls",
			parameters: Type.Object({
				tool_name: Type.String(),
				input: Type.Any(),
				tool_use_id: Type.String(),
				cwd: Type.String(),
			}),
			execute: async (_toolCallId, params) => {
				approvalInputs.push(params);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ behavior: "allow", updatedInput: { text: "hook-approved" } }),
						},
					],
					details: undefined,
				};
			},
		};
		const harness = await createHarness({ tools: [echoTool, approvalTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "original" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "");
			},
		]);

		await harness.session.prompt("hi");

		expect(approvalInputs).toMatchObject([
			{
				input: { text: "original" },
				tool_name: "echo",
			},
		]);
		expect(getAssistantTexts(harness)).toContain("hook-approved");
	});

	it("falls back to native approval when permission prompt tool discovery is ambiguous", async () => {
		const approvalInputs: unknown[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return {
					content: [{ type: "text", text }],
					details: { text },
				};
			},
		};
		const createApprovalTool = (name: string): AgentTool => ({
			name,
			label: "Approval",
			description: "Approve tool calls",
			parameters: Type.Object({
				tool_name: Type.String(),
				input: Type.Any(),
				tool_use_id: Type.String(),
				cwd: Type.String(),
			}),
			execute: async (_toolCallId, params) => {
				approvalInputs.push(params);
				return {
					content: [{ type: "text", text: JSON.stringify({ behavior: "allow", updatedInput: { text: name } }) }],
					details: undefined,
				};
			},
		});
		const harness = await createHarness({
			tools: [
				echoTool,
				createApprovalTool("mcp__claude-bash-hook-approval__approval_prompt"),
				createApprovalTool("mcp__other-approval__approval_prompt"),
			],
			uiContext: createConfirmUiContext(
				async () => false,
				async () => "Allow once",
			),
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "original" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "");
			},
		]);

		await harness.session.prompt("hi");

		expect(approvalInputs).toEqual([]);
		expect(getAssistantTexts(harness)).toContain("original");
	});

	it("blocks tool calls denied by the configured permission prompt tool", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				throw new Error("tool should have been blocked");
			},
		};
		const approvalTool: AgentTool = {
			name: "mcp__approval__prompt",
			label: "Approval",
			description: "Approve tool calls",
			parameters: Type.Object({
				tool_name: Type.String(),
				input: Type.Any(),
				tool_use_id: Type.String(),
				cwd: Type.String(),
			}),
			execute: async () => ({
				content: [{ type: "text", text: JSON.stringify({ behavior: "deny", message: "blocked by policy" }) }],
				details: undefined,
			}),
		};
		const harness = await createHarness({
			settings: { permissionPromptTool: "mcp__approval__prompt" },
			tools: [echoTool, approvalTool],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "original" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "");
			},
		]);

		await harness.session.prompt("hi");

		expect(getAssistantTexts(harness)).toContain("blocked by policy");
		expect(
			harness.session.messages.find((message) => message.role === "toolResult" && message.isError),
		).toBeDefined();
	});

	it("skips configured permission prompt tool when persisted allow rule matches", async () => {
		let approvalCalls = 0;
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return {
					content: [{ type: "text", text }],
					details: { text },
				};
			},
		};
		const approvalTool: AgentTool = {
			name: "mcp__approval__prompt",
			label: "Approval",
			description: "Approve tool calls",
			parameters: Type.Object({
				tool_name: Type.String(),
				input: Type.Any(),
				tool_use_id: Type.String(),
				cwd: Type.String(),
			}),
			execute: async () => {
				approvalCalls++;
				return {
					content: [{ type: "text", text: JSON.stringify({ behavior: "deny", message: "should not run" }) }],
					details: undefined,
				};
			},
		};
		const harness = await createHarness({
			settings: {
				permissionPromptTool: "mcp__approval__prompt",
				permissionRules: {
					allow: {
						echo: [JSON.stringify({ text: "original" })],
					},
				},
			},
			tools: [echoTool, approvalTool],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "original" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "");
			},
		]);

		await harness.session.prompt("hi");

		expect(approvalCalls).toBe(0);
		expect(getAssistantTexts(harness)).toContain("original");
	});

	it("allows extension tool_result handlers to modify tool results", async () => {
		const resultEvents: Array<{
			toolName: string;
			toolCallId: string;
			input: Record<string, unknown>;
			contentText: string;
			details: unknown;
			isError: boolean;
		}> = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text }], details: { text } };
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", async (event) => {
						resultEvents.push({
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							input: event.input,
							contentText: event.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n"),
							details: event.details,
							isError: event.isError,
						});
						return {
							content: [{ type: "text", text: "patched result" }],
							details: { patched: true },
							isError: true,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				const text =
					toolResult?.role === "toolResult"
						? toolResult.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage(text);
			},
		]);

		await harness.session.prompt("hi");

		expect(resultEvents).toMatchObject([
			{
				toolName: "echo",
				input: { text: "hello" },
				contentText: "hello",
				details: { text: "hello" },
				isError: false,
			},
		]);
		expect(resultEvents[0]?.toolCallId).toMatch(/^tool[:_-]/);
		expect(getAssistantTexts(harness)).toContain("patched result");
		expect(
			harness.session.messages.find((message) => message.role === "toolResult" && message.details?.patched === true),
		).toBeDefined();
		expect(
			harness.session.messages.find((message) => message.role === "toolResult" && message.isError),
		).toBeDefined();
	});

	it("allows extension context handlers to modify messages before the LLM call", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("context", async (event) => ({
						messages: event.messages.map((message) =>
							message.role === "user"
								? { ...message, content: [{ type: "text", text: "rewritten" }], timestamp: message.timestamp }
								: message,
						),
					}));
				},
			],
		});
		harnesses.push(harness);
		let providerUserText = "";
		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				providerUserText =
					user && typeof user.content !== "string"
						? user.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("original");

		expect(providerUserText).toBe("rewritten");
		const storedUserMessage = harness.session.messages.find((message) => message.role === "user");
		expect(storedUserMessage?.role).toBe("user");
		if (storedUserMessage?.role === "user") {
			expect(storedUserMessage.content).toEqual([{ type: "text", text: "original" }]);
		}
	});

	it("allows extension input handlers to transform or handle input", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const transformedHarness = await createHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
					pi.on("input", async (event) => {
						if (event.text === "ping") {
							return { action: "handled" };
						}
						return { action: "transform", text: `transformed:${event.text}` };
					});
				},
			],
		});
		harnesses.push(transformedHarness);
		let providerUserText = "";
		transformedHarness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				providerUserText =
					user && typeof user.content !== "string"
						? user.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage("done");
			},
		]);

		await transformedHarness.session.prompt("hello");
		await transformedHarness.session.prompt("ping");

		expect(providerUserText).toBe("transformed:hello");
		expect(transformedHarness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(extensionApi).toBeDefined();
	});

	it("allows extension commands to inspect live system prompt options", async () => {
		const seenOptions: BuildSystemPromptOptions[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("inspect-options", {
						description: "Inspect system prompt options",
						handler: async (_args, ctx) => {
							const options = ctx.getSystemPromptOptions();
							seenOptions.push(options);
							options.selectedTools?.push("mutated_tool");
						},
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("/inspect-options");
		await harness.session.prompt("/inspect-options");

		expect(seenOptions).toHaveLength(2);
		expect(seenOptions[0]).toBe(seenOptions[1]);
		expect(seenOptions[0]?.cwd).toBe(harness.tempDir);
		expect(seenOptions[0]?.selectedTools).toContain("read");
		expect(seenOptions[1]?.selectedTools).toContain("mutated_tool");
	});

	it("allows before_agent_start handlers to inject custom messages and modify the system prompt", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => ({
						message: {
							customType: "before-start",
							content: "injected",
							display: true,
							details: { injected: true },
						},
						systemPrompt: `${event.systemPrompt}\n\nextra instructions`,
					}));
				},
			],
		});
		harnesses.push(harness);
		let providerSystemPrompt = "";
		let sawInjectedUserMessage = false;
		harness.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				sawInjectedUserMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "injected"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("hello");

		expect(providerSystemPrompt).toContain("extra instructions");
		expect(sawInjectedUserMessage).toBe(true);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "before-start"),
		).toBe(true);
	});

	it("bindExtensions emits session_start and reload emits session_shutdown then session_start", async () => {
		const lifecycleEvents: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (event) => {
						lifecycleEvents.push(`start:${event.reason}`);
					});
					pi.on("session_shutdown", async (event) => {
						lifecycleEvents.push(`shutdown:${event.reason}`);
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		await harness.session.reload();

		expect(lifecycleEvents).toEqual(["start:startup", "shutdown:reload", "start:reload"]);
	});

	it("adds restart to extension command contexts", async () => {
		const restart = vi.fn(async () => {});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("restart-now", {
						description: "Restart current session",
						async handler(_args, ctx) {
							await ctx.restart({ notice: "Restarted test session." });
						},
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.bindExtensions({
			commandContextActions: {
				showApprovalSelector: () => {},
				showSandboxSelector: () => {},
				waitForIdle: async () => {},
				newSession: async () => ({ cancelled: false }),
				fork: async () => ({ cancelled: false }),
				navigateTree: async () => ({ cancelled: false }),
				switchSession: async () => ({ cancelled: false }),
				reload: async () => {},
				restart,
			},
		});
		await harness.session.prompt("/restart-now");

		expect(restart).toHaveBeenCalledWith({ notice: "Restarted test session." });
	});
});
