import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Api, fauxAssistantMessage, fauxToolCall, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InputEvent } from "../../src/core/extensions/index.ts";
import type { PromptTemplate } from "../../src/core/prompt-templates.ts";
import { getControlDbPath, readPromptHistory, recordPromptHistoryEntry } from "../../src/core/session-control-db.ts";
import type { SessionMessageEntry } from "../../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function fauxEndTurn(reason: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage(fauxToolCall("end_turn", { reason }), { stopReason: "toolUse" });
}

const DUPLICATE_TURN_GUARD_TEXT = "You repeated the same response.";

describe("AgentSession prompt characterization", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	async function createTrackedHarness(options?: Parameters<typeof createHarness>[0]): Promise<Harness> {
		const harness = await createHarness(options);
		harnesses.push(harness);
		return harness;
	}

	function createDeferred(): { promise: Promise<void>; resolve: () => void } {
		let resolve!: () => void;
		const promise = new Promise<void>((promiseResolve) => {
			resolve = promiseResolve;
		});
		return { promise, resolve };
	}

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("does not start a continuation for an empty transcript", async () => {
		const harness = await createTrackedHarness({ withConfiguredAuth: false });

		harness.setResponses([fauxAssistantMessage("unexpected")]);

		await harness.session.continue();

		expect(harness.session.messages).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("continues after a completed assistant response without queued messages", async () => {
		const harness = await createTrackedHarness();
		const initialAssistant = fauxAssistantMessage("done");
		harness.session.agent.state.messages = [initialAssistant];
		harness.setResponses([fauxAssistantMessage("continued"), fauxEndTurn("characterization complete")]);

		await harness.session.continue();

		expect(harness.session.messages).toHaveLength(4);
		expect(harness.session.messages[0]).toEqual(initialAssistant);
		expect(getMessageText(harness.session.messages[1])).toBe("continued");
		expect(harness.session.messages[2]?.role).toBe("assistant");
		expect(harness.session.messages[3]?.role).toBe("toolResult");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("prompts while idle and records a single text response", async () => {
		const harness = await createTrackedHarness();

		harness.setResponses([fauxAssistantMessage("hello"), fauxEndTurn("characterization complete")]);

		await harness.session.prompt("hi");

		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"assistant",
			"toolResult",
		]);
		const firstMessage = harness.session.messages[0];
		if (!firstMessage) throw new Error("Expected first message");
		expect(getMessageText(firstMessage)).toBe("hi");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("delivers agent_start to listeners added after a self-unsubscribing listener", async () => {
		const harness = await createTrackedHarness();
		harness.setResponses([fauxEndTurn("listener characterization complete")]);

		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "agent_start") unsubscribe();
		});
		let secondListenerReceivedStart = false;
		harness.session.subscribe((event) => {
			if (event.type === "agent_start") secondListenerReceivedStart = true;
		});

		await harness.session.prompt("listener test");

		expect(secondListenerReceivedStart).toBe(true);
	});

	it("steers the model to end_turn after consecutive identical assistant turns without persisting the instruction", async () => {
		const harness = await createTrackedHarness({ initialActiveToolNames: ["end_turn"] });
		expect(harness.session.getActiveToolNames()).toContain("end_turn");
		let guardPrompt = "";
		harness.setResponses([
			fauxAssistantMessage("same response"),
			fauxAssistantMessage("same response"),
			(context) => {
				const guardMessage = context.messages.find(
					(message) => message.role === "user" && getMessageText(message).includes(DUPLICATE_TURN_GUARD_TEXT),
				);
				guardPrompt = guardMessage ? getMessageText(guardMessage) : "";
				return fauxAssistantMessage(fauxToolCall("end_turn", { reason: "duplicate response detected" }), {
					stopReason: "toolUse",
				});
			},
		]);

		await harness.session.prompt("start");
		await harness.session.continue();

		expect(harness.session.getActiveToolNames()).toContain("end_turn");
		expect(guardPrompt).toContain("end_turn");
		expect(guardPrompt).toContain("concise reason");
		expect(
			harness.session.messages.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some((part) => part.type === "toolCall" && part.name === "end_turn"),
			),
		).toBe(true);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry): entry is SessionMessageEntry => entry.type === "message" && entry.message.role === "user")
				.map((entry) => getMessageText(entry.message)),
		).toEqual(["start"]);

		const duplicateAssistantEnds = harness
			.eventsOfType("message_end")
			.filter((event) => event.message.role === "assistant");
		expect(duplicateAssistantEnds[1]?.runtimeMessageMarker).toBe("duplicate_turn_assistant");
		const guardStart = harness
			.eventsOfType("message_start")
			.find((event) => event.message.role === "user" && getMessageText(event.message).includes("end_turn"));
		expect(guardStart?.runtimeMessageMarker).toBe("duplicate_turn_guard");
	});

	it("terminates when the model repeats after the duplicate-turn guard", async () => {
		const harness = await createTrackedHarness({ initialActiveToolNames: ["end_turn"] });
		harness.setResponses([
			fauxAssistantMessage({ type: "text", text: "same response", textSignature: "signature-1" }),
			fauxAssistantMessage({ type: "text", text: "same response", textSignature: "signature-2" }),
			fauxAssistantMessage({ type: "text", text: "same response", textSignature: "signature-3" }),
		]);

		await harness.session.prompt("start");

		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(
			harness.session.messages
				.filter((message) => message.role === "assistant")
				.map((message) => getMessageText(message))
				.filter((text) => text.length > 0),
		).toEqual(["same response", "same response", "same response"]);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("applies duplicate-turn guard to child runtimes without persisting the instruction", async () => {
		const harness = await createTrackedHarness({
			initialActiveToolNames: [],
			excludedToolNames: ["end_turn"],
			multiAgentAgentId: "child-1",
			multiAgentParentSessionId: "parent-1",
			multiAgentRuntimeRole: "child",
		});
		expect(harness.session.getActiveToolNames()).toContain("end_turn");
		let sawGuard = false;
		harness.setResponses([
			fauxAssistantMessage("same response"),
			fauxAssistantMessage("same response"),
			(context) => {
				sawGuard = context.messages.some(
					(message) => message.role === "user" && getMessageText(message).includes(DUPLICATE_TURN_GUARD_TEXT),
				);
				return fauxAssistantMessage("child recovered");
			},
		]);

		await harness.session.prompt("child start");
		await harness.session.continue();

		expect(sawGuard).toBe(true);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry): entry is SessionMessageEntry => entry.type === "message" && entry.message.role === "user")
				.map((entry) => getMessageText(entry.message)),
		).toEqual(["child start"]);
	});

	it("injects the guard when end_turn was filtered from the initial active tools", async () => {
		const harness = await createTrackedHarness({ initialActiveToolNames: [], excludedToolNames: ["end_turn"] });
		expect(harness.session.getActiveToolNames()).toContain("end_turn");
		let sawGuard = false;
		harness.setResponses([
			fauxAssistantMessage("same response"),
			fauxAssistantMessage("same response"),
			(context) => {
				sawGuard = context.messages.some(
					(message) => message.role === "user" && getMessageText(message).includes(DUPLICATE_TURN_GUARD_TEXT),
				);
				return fauxAssistantMessage("recovered");
			},
		]);

		await harness.session.prompt("start");
		await harness.session.continue();

		expect(sawGuard).toBe(true);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry): entry is SessionMessageEntry => entry.type === "message" && entry.message.role === "user")
				.map((entry) => getMessageText(entry.message)),
		).toEqual(["start"]);
	});

	it("resets duplicate detection when assistant content changes", async () => {
		const harness = await createTrackedHarness({ initialActiveToolNames: [] });
		let sawGuard = false;
		harness.setResponses([
			fauxAssistantMessage("first"),
			fauxAssistantMessage("second"),
			(context) => {
				sawGuard = context.messages.some(
					(message) => message.role === "user" && getMessageText(message).includes(DUPLICATE_TURN_GUARD_TEXT),
				);
				return fauxAssistantMessage("third");
			},
		]);

		await harness.session.prompt("start");
		await harness.session.continue();

		expect(sawGuard).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("resets duplicate detection after tool execution", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return {
					content: [{ type: "text", text }],
					details: undefined,
				};
			},
		};
		const harness = await createTrackedHarness({ tools: [echoTool], initialActiveToolNames: ["echo"] });
		let sawGuard = false;
		harness.setResponses([
			fauxAssistantMessage("same response"),
			fauxAssistantMessage(fauxToolCall("echo", { text: "tool output" }), { stopReason: "toolUse" }),
			(context) => {
				sawGuard = context.messages.some(
					(message) => message.role === "user" && getMessageText(message).includes(DUPLICATE_TURN_GUARD_TEXT),
				);
				return fauxAssistantMessage("same response");
			},
			fauxAssistantMessage("unexpected"),
		]);

		await harness.session.prompt("start");
		await harness.session.continue();

		expect(sawGuard).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("resets duplicate detection after new user input", async () => {
		const harness = await createTrackedHarness({ initialActiveToolNames: [] });
		let sawGuard = false;
		harness.setResponses([
			fauxAssistantMessage("same response"),
			(context) => {
				sawGuard = context.messages.some(
					(message) => message.role === "user" && getMessageText(message).includes(DUPLICATE_TURN_GUARD_TEXT),
				);
				return fauxAssistantMessage("same response");
			},
			fauxAssistantMessage("unexpected"),
		]);

		await harness.session.prompt("first");
		await harness.session.prompt("second");

		expect(sawGuard).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("handles a tool call turn and waits for the follow-up LLM response", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return {
					content: [{ type: "text", text: `echo:${text}` }],
					details: { text },
				};
			},
		};
		const harness = await createTrackedHarness({ tools: [echoTool] });

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxEndTurn("characterization complete"),
		]);

		await harness.session.prompt("start");

		expect(toolRuns).toEqual(["hello"]);
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
			"assistant",
			"toolResult",
		]);
		expect(harness.session.messages[2]?.role).toBe("toolResult");
		expect(harness.session.messages[3]?.role).toBe("assistant");
		expect(harness.session.messages[4]?.role).toBe("assistant");
		expect(harness.session.messages[5]?.role).toBe("toolResult");
	});

	it("executes multiple tool calls from one response and continues with a single follow-up response", async () => {
		const toolRuns: string[] = [];
		const makeTool = (name: string, delayMs: number): AgentTool => ({
			name,
			label: name,
			description: `${name} tool`,
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_toolCallId, params) => {
				const value =
					typeof params === "object" && params !== null && "value" in params ? String(params.value) : "";
				await new Promise((resolve) => setTimeout(resolve, delayMs));
				toolRuns.push(`${name}:${value}`);
				return {
					content: [{ type: "text", text: `${name}:${value}` }],
					details: { value },
				};
			},
		});
		const harness = await createTrackedHarness({ tools: [makeTool("slow", 25), makeTool("fast", 0)] });

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("slow", { value: "a" }), fauxToolCall("fast", { value: "b" })], {
				stopReason: "toolUse",
			}),
			(context) => {
				const toolResults = context.messages.filter((message) => message.role === "toolResult");
				return fauxAssistantMessage(`tool results: ${toolResults.length}`);
			},
		]);

		await harness.session.prompt("run tools");

		expect(toolRuns.sort()).toEqual(["fast:b", "slow:a"]);
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("assistant");
	});

	it("preserves image attachments in the provider context", async () => {
		const harness = await createTrackedHarness();
		let sawImage = false;

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				sawImage =
					user?.role === "user" &&
					typeof user.content !== "string" &&
					user.content.some((part) => part.type === "image");
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("describe", {
			images: [
				{
					type: "image",
					mimeType: "image/png",
					data: "ZmFrZQ==",
				},
			],
		});

		expect(sawImage).toBe(true);
	});

	it.each([" ", "\n", "\t"])("expands a skill command followed by %j before sending the prompt", async (separator) => {
		const tempDir = join(tmpdir(), `pi-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		const skillPath = join(tempDir, "test-skill.md");
		writeFileSync(skillPath, "# Test Skill\n\nUse the skill body.");

		const resourceLoader = {
			...createTestResourceLoader(),
			getSkills: () => ({
				skills: [
					{
						name: "test",
						description: "Test skill",
						filePath: skillPath,
						disableModelInvocation: false,
						baseDir: tempDir,
						sourceInfo: createSyntheticSourceInfo(skillPath, {
							source: "local",
							scope: "project",
							origin: "top-level",
							baseDir: tempDir,
						}),
					},
				],
				diagnostics: [],
			}),
		};
		const harness = await createTrackedHarness({ resourceLoader });
		let expandedPrompt = "";

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				expandedPrompt = user ? getMessageText(user) : "";
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt(`/skill:test${separator}explain this`);

		expect(expandedPrompt).toContain('<skill name="test" location="');
		expect(expandedPrompt).toContain("Use the skill body.");
		expect(expandedPrompt).toContain("explain this");
	});

	it("expands prompt templates before sending the prompt", async () => {
		const template: PromptTemplate = {
			name: "review",
			description: "Review template",
			content: "Review this code: $1",
			filePath: "/virtual/review.md",
			sourceInfo: createSyntheticSourceInfo("/virtual/review.md", {
				source: "local",
				scope: "temporary",
				origin: "top-level",
			}),
		};
		const resourceLoader = {
			...createTestResourceLoader(),
			getPrompts: () => ({ prompts: [template], diagnostics: [] }),
		};
		const harness = await createTrackedHarness({ resourceLoader });
		let expandedPrompt = "";

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				expandedPrompt = user ? getMessageText(user) : "";
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("/review src/index.ts");

		expect(expandedPrompt).toBe("Review this code: src/index.ts");
	});

	it("dispatches extension commands without consuming a provider response", async () => {
		const commandRuns: string[] = [];
		const harness = await createTrackedHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("should stay queued")]);

		await harness.session.prompt("/testcmd hello world");
		await harness.session.prompt("/testcmd\nsecond line");

		expect(commandRuns).toEqual(["hello world", "second line"]);
		expect(harness.session.messages).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(readPromptHistory(getControlDbPath(harness.tempDir))).toEqual([
			"/testcmd\nsecond line",
			"/testcmd hello world",
		]);
	});

	it("rejects unknown slash commands instead of sending them to the provider", async () => {
		const harness = await createTrackedHarness();
		harness.setResponses([fauxAssistantMessage("should not run")]);

		await expect(harness.session.prompt("/does-not-exist hello")).rejects.toThrow(
			"Unknown slash command: /does-not-exist",
		);
		expect(harness.session.messages).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("does not duplicate a handled extension command already recorded by the editor", async () => {
		const harness = await createTrackedHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async () => {},
					});
				},
			],
		});
		const controlDbPath = getControlDbPath(harness.tempDir);
		recordPromptHistoryEntry(controlDbPath, "/testcmd hello world");

		await harness.session.prompt("/testcmd hello world");

		expect(readPromptHistory(controlDbPath)).toEqual(["/testcmd hello world"]);
	});

	it("sendUserMessage while idle triggers a turn", async () => {
		const harness = await createTrackedHarness();

		harness.setResponses([fauxAssistantMessage("response"), fauxEndTurn("characterization complete")]);

		await harness.session.sendUserMessage("from extension");

		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"assistant",
			"toolResult",
		]);
		const firstMessage = harness.session.messages[0];
		if (!firstMessage) throw new Error("Expected first message");
		expect(getMessageText(firstMessage)).toBe("from extension");
	});

	it("does not report streamingBehavior to input handlers while idle", async () => {
		const inputEvents: InputEvent[] = [];
		const harness = await createTrackedHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => {
						inputEvents.push(event);
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.prompt("idle", { streamingBehavior: "followUp" });

		expect(inputEvents).toHaveLength(1);
		expect(inputEvents[0]?.streamingBehavior).toBeUndefined();
	});

	it("reports streamingBehavior to input handlers while streaming", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const inputEvents: InputEvent[] = [];
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return {
					content: [{ type: "text", text: "released" }],
					details: {},
				};
			},
		};
		const harness = await createTrackedHarness({
			tools: [waitTool],
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => {
						inputEvents.push(event);
					});
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("start");
		await sawToolStart;
		await harness.session.prompt("queued", { streamingBehavior: "followUp" });

		expect(inputEvents.map((event) => event.streamingBehavior)).toEqual([undefined, "followUp"]);

		releaseToolExecution?.();
		await promptPromise;
	});

	it("manual compaction waits for a prompt that holds the turn-start arbiter", async () => {
		const harness = await createTrackedHarness();
		harness.setResponses([fauxAssistantMessage("prompt")]);
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "previous" }], timestamp: Date.now() },
			fauxAssistantMessage("", { stopReason: "aborted" }),
		];

		const compactionStarted = createDeferred();
		const releaseCompaction = createDeferred();
		let compactionChecks = 0;
		vi.spyOn(
			harness.session as unknown as {
				_checkCompaction: (message: unknown, postRunCheck?: boolean) => Promise<boolean>;
			},
			"_checkCompaction",
		).mockImplementation(async () => {
			compactionChecks += 1;
			if (compactionChecks === 1) {
				compactionStarted.resolve();
				await releaseCompaction.promise;
			}
			return false;
		});

		const events: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "agent_start" || event.type === "compaction_start") events.push(event.type);
		});

		const prompt = harness.session.prompt("prompt", { streamingBehavior: "followUp" });
		await compactionStarted.promise;
		const manualCompaction = harness.session.compact().catch(() => undefined);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(events).toEqual([]);
		expect(harness.session.isCompacting).toBe(false);
		releaseCompaction.resolve();

		await expect(prompt).resolves.toBeUndefined();
		await manualCompaction;
		expect(events.slice(0, 2)).toEqual(["agent_start", "compaction_start"]);
	});

	it("queues a prompt when a trigger-turn custom message races compaction preflight", async () => {
		const harness = await createTrackedHarness();
		harness.setResponses([fauxAssistantMessage("custom"), fauxAssistantMessage("prompt")]);
		harness.session.agent.state.messages = [fauxAssistantMessage("previous")];

		const compactionStarted = createDeferred();
		const releaseCompaction = createDeferred();
		let compactionChecks = 0;
		vi.spyOn(
			harness.session as unknown as {
				_checkCompaction: (message: unknown, postRunCheck?: boolean) => Promise<boolean>;
			},
			"_checkCompaction",
		).mockImplementation(async () => {
			compactionChecks += 1;
			if (compactionChecks === 1) {
				compactionStarted.resolve();
				await releaseCompaction.promise;
			}
			return false;
		});

		const prompt = harness.session.prompt("prompt", { streamingBehavior: "followUp" });
		await compactionStarted.promise;

		const custom = harness.session.sendCustomMessage(
			{ customType: "race", content: [{ type: "text", text: "custom" }], display: false },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		expect(harness.session.isStreaming).toBe(false);
		releaseCompaction.resolve();

		await expect(custom).resolves.toBeUndefined();
		await expect(prompt).resolves.toBeUndefined();
	});

	it.each(["steer", "followUp"] as const)(
		"queues a %s prompt when compaction preflight races another prompt",
		async (streamingBehavior) => {
			const harness = await createTrackedHarness();
			harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
			harness.session.agent.state.messages = [fauxAssistantMessage("previous")];

			const compactionStarted = createDeferred();
			const releaseCompaction = createDeferred();
			let compactionChecks = 0;
			vi.spyOn(
				harness.session as unknown as {
					_checkCompaction: (message: unknown, postRunCheck?: boolean) => Promise<boolean>;
				},
				"_checkCompaction",
			).mockImplementation(async () => {
				compactionChecks += 1;
				if (compactionChecks === 1) {
					compactionStarted.resolve();
					await releaseCompaction.promise;
				}
				return false;
			});

			const firstPrompt = harness.session.prompt("first");
			await compactionStarted.promise;

			const secondStarted = new Promise<void>((resolve) => {
				const unsubscribe = harness.session.subscribe((event) => {
					if (event.type === "agent_start") {
						unsubscribe();
						resolve();
					}
				});
			});
			const secondPrompt = harness.session.prompt("second", { streamingBehavior });
			releaseCompaction.resolve();
			await secondStarted;

			await expect(firstPrompt).resolves.toBeUndefined();
			await expect(secondPrompt).resolves.toBeUndefined();
			expect(harness.session.messages.filter((message) => message.role === "user").map(getMessageText)).toEqual([
				"first",
				"second",
			]);
		},
	);

	it("queues a prompt while continue preflight owns the turn-start transition", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createTrackedHarness({ tools: [waitTool] });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("continued"),
			fauxEndTurn("continued characterization complete"),
			fauxAssistantMessage("queued"),
			fauxEndTurn("queued characterization complete"),
		]);
		harness.session.agent.state.messages = [fauxAssistantMessage("previous")];

		const compactionStarted = createDeferred();
		const releaseCompaction = createDeferred();
		vi.spyOn(
			harness.session as unknown as {
				_checkCompaction: (message: unknown, postRunCheck?: boolean) => Promise<boolean>;
			},
			"_checkCompaction",
		).mockImplementation(async () => {
			compactionStarted.resolve();
			await releaseCompaction.promise;
			return false;
		});

		const continuation = harness.session.continue();
		await compactionStarted.promise;
		const queuedPrompt = harness.session.prompt("queued", { streamingBehavior: "followUp" });
		releaseCompaction.resolve();

		await new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});
		await expect(queuedPrompt).resolves.toBeUndefined();
		expect(harness.session.pendingMessageCount).toBe(1);
		releaseToolExecution?.();
		await expect(continuation).resolves.toBeUndefined();
		expect(harness.session.messages.filter((message) => message.role === "assistant").map(getMessageText)).toEqual([
			"previous",
			"",
			"continued",
			"",
			"queued",
			"",
		]);
	});

	it("throws when prompted during streaming without a streamingBehavior", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return {
					content: [{ type: "text", text: "released" }],
					details: {},
				};
			},
		};
		const harness = await createTrackedHarness({ tools: [waitTool] });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("start");
		await sawToolStart;

		await expect(harness.session.prompt("second")).rejects.toThrow(
			"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
		);

		releaseToolExecution?.();
		await promptPromise;
	});

	it("throws when prompting without a model", async () => {
		const harness = await createTrackedHarness();
		harness.session.agent.state.model = undefined as unknown as Model<Api>;

		await expect(harness.session.prompt("hi")).rejects.toThrow("No model selected.");
	});

	it("throws when prompting without configured auth", async () => {
		const harness = await createTrackedHarness({ withConfiguredAuth: false });

		await expect(harness.session.prompt("hi")).rejects.toThrow(
			`No API key found for ${harness.getModel().provider}.`,
		);
	});
});
