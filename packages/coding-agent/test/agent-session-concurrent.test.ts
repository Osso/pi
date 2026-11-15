/**
 * Tests for AgentSession concurrent prompt guard.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, STEERING_INTERRUPTION_NOTE, type StreamFn } from "@earendil-works/pi-agent-core";
import { fauxToolCall } from "@earendil-works/pi-ai";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type ImageContent,
	type Message,
	type TextContent,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

// Mock stream that mimics AssistantMessageEventStream
class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function getUserMessageText(content: string | Array<TextContent | ImageContent>): string {
	if (typeof content === "string") return content;
	return content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: tokenUsage(0),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createCompletedAssistantMessage(text: string): AssistantMessage {
	return {
		...createAssistantMessage(text),
		content: [{ type: "text", text }, fauxToolCall("end_turn", { reason: text })],
		stopReason: "toolUse",
	};
}

function requireModel<T>(model: T | undefined): T {
	if (!model) throw new Error("Expected test model to exist");
	return model;
}

function tokenUsage(input: number, output = 0) {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("AgentSession concurrent prompt guard", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-concurrent-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		delete (globalThis as typeof globalThis & { testExtensionApi?: unknown }).testExtensionApi;
		delete (globalThis as typeof globalThis & { testCommandRuns?: unknown }).testCommandRuns;
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	/** The in-memory services an AgentSession around `agent` needs; `authenticated` stores an Anthropic key. */
	function sessionServices(agent: Agent, authenticated = true) {
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		if (authenticated) authStorage.setRuntimeApiKey("anthropic", "test-key");
		return {
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry,
		};
	}

	function createSession(options: { authenticated?: boolean; streamFn?: StreamFn } = {}) {
		const model = requireModel(getModel("anthropic", "claude-sonnet-4-5"));
		let abortSignal: AbortSignal | undefined;

		// Use a stream function that responds to abort
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn:
				options.streamFn ??
				((_model, context, options) => {
					abortSignal = options?.signal;
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						const userTexts = context.messages.map((message) =>
							message.role === "user" ? getUserMessageText(message.content) : "",
						);
						if (userTexts.includes("Steering message") || userTexts.includes("Follow-up message")) {
							stream.push({ type: "start", partial: createAssistantMessage("") });
							const message = createCompletedAssistantMessage("Queued");
							stream.push({ type: "done", reason: "toolUse", message });
							return;
						}

						stream.push({ type: "start", partial: createAssistantMessage("") });
						const checkAbort = () => {
							if (abortSignal?.aborted) {
								stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
							} else {
								setTimeout(checkAbort, 5);
							}
						};
						checkAbort();
					});
					return stream;
				}),
		});

		session = new AgentSession({
			...sessionServices(agent, options.authenticated !== false),
			resourceLoader: createTestResourceLoader(),
		});

		return session;
	}

	it("should throw when prompt() called while streaming", async () => {
		createSession();

		// Start first prompt (don't await, it will block until abort)
		const firstPrompt = session.prompt("First message");

		// Wait a tick for isStreaming to be set
		await new Promise((resolve) => setTimeout(resolve, 10));

		// Verify we're streaming
		expect(session.isStreaming).toBe(true);

		// Second prompt should reject
		await expect(session.prompt("Second message")).rejects.toThrow(
			"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
		);

		// Cleanup
		await session.abort();
		await firstPrompt.catch(() => {}); // Ignore abort error
	});

	it("does not retain idle steering when authentication fails", async () => {
		createSession({ authenticated: false });

		await expect(session.steer("Steering message")).rejects.toThrow("No API key found for anthropic");
		expect(session.pendingMessageCount).toBe(0);
	});

	it("should allow steer() while streaming", async () => {
		createSession();

		// Start first prompt
		const firstPrompt = session.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));

		// steer should work while streaming
		await expect(session.steer("Steering message")).resolves.toBeUndefined();
		expect(session.pendingMessageCount).toBe(1);

		// Cleanup
		await session.abort();
		await firstPrompt.catch(() => {});
	});

	it("interrupts model thinking and continues with steering", async () => {
		createSession();
		const firstPrompt = session.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));

		await session.steer("Steering message");

		const outcome = await Promise.race([
			firstPrompt.then(() => "completed"),
			new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 200)),
		]);
		expect(outcome).toBe("completed");
		expect(
			session.messages
				.filter((message) => message.role === "user")
				.map((message) => getUserMessageText(message.content)),
		).toEqual(["First message", "Steering message"]);
	});

	it("waits for the thinking block to end, then continues with the thinking and the steering", async () => {
		const requests: Message[][] = [];
		const thinking = { type: "thinking" as const, thinking: "Plan A", thinkingSignature: "sig-a" };
		let endThinking = () => {};
		createSession({
			streamFn: (_model, context) => {
				requests.push(structuredClone(context.messages));
				const stream = new MockAssistantStream();
				const open = {
					...createAssistantMessage(""),
					content: [{ type: "thinking" as const, thinking: "Plan A" }],
				};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					if (requests.length > 1) {
						stream.push({ type: "done", reason: "toolUse", message: createCompletedAssistantMessage("Steered") });
						return;
					}
					stream.push({ type: "thinking_start", contentIndex: 0, partial: open });
				});
				endThinking = () => {
					const closed = { ...open, content: [thinking] };
					stream.push({ type: "thinking_end", contentIndex: 0, content: "Plan A", partial: closed });
				};
				return stream;
			},
		});
		const firstPrompt = session.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));

		await session.steer("Steering message");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(requests).toHaveLength(1);

		endThinking();
		await firstPrompt;

		const kept = {
			role: "assistant",
			stopReason: "stop",
			content: [thinking, { type: "text", text: STEERING_INTERRUPTION_NOTE }],
		};
		expect(requests[1]?.slice(1, 3)).toMatchObject([
			kept,
			{ role: "user", content: [{ type: "text", text: "Steering message" }] },
		]);
		expect(
			session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message")
				.map((entry) => entry.message)
				.slice(0, 4),
		).toMatchObject([{ role: "user" }, kept, { role: "user" }, { role: "assistant", stopReason: "toolUse" }]);
	});

	it("should allow followUp() while streaming", async () => {
		createSession();

		// Start first prompt
		const firstPrompt = session.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));

		// followUp should work while streaming
		await expect(session.followUp("Follow-up message")).resolves.toBeUndefined();
		expect(session.pendingMessageCount).toBe(1);

		// Cleanup
		await session.abort();
		await firstPrompt.catch(() => {});
	});

	it("should interrupt model thinking for extension-origin steering messages", async () => {
		const model = requireModel(getModel("anthropic", "claude-sonnet-4-5"));
		let abortSignal: AbortSignal | undefined;
		let lastInputSource: string | undefined;
		const queueEvents: Array<{ steering: readonly string[]; followUp: readonly string[] }> = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: (_model, context, options) => {
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const userTexts = context.messages
						.filter((message) => message.role === "user")
						.map((message) => getUserMessageText(message.content));

					if (userTexts.includes("Steer from extension")) {
						stream.push({ type: "start", partial: createAssistantMessage("") });
						const message = createCompletedAssistantMessage("Steered");
						stream.push({ type: "done", reason: "toolUse", message });
						return;
					}

					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				(globalThis as typeof globalThis & { testExtensionApi?: unknown }).testExtensionApi = pi;
			},
			(pi) => {
				pi.on("input", async (event) => {
					lastInputSource = event.source;
				});
			},
		]);

		session = new AgentSession({
			...sessionServices(agent),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		session.subscribe((event) => {
			if (event.type === "queue_update") {
				queueEvents.push({ steering: event.steering, followUp: event.followUp });
			}
		});

		const firstPrompt = session.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(session.isStreaming).toBe(true);

		const pi = (
			globalThis as typeof globalThis & {
				testExtensionApi?: {
					sendUserMessage: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
				};
			}
		).testExtensionApi;
		expect(pi).toBeDefined();

		if (!pi) throw new Error("Expected extension API to be available");
		pi.sendUserMessage("Steer from extension", { deliverAs: "steer" });
		await firstPrompt;

		expect(session.pendingMessageCount).toBe(0);
		expect(lastInputSource).toBe("extension");
		expect(queueEvents.some((event) => event.steering.includes("Steer from extension"))).toBe(true);
		expect(
			session.messages
				.filter((message) => message.role === "user")
				.map((message) => getUserMessageText(message.content)),
		).toEqual(["First message", "Steer from extension"]);
	});

	it("should allow prompt() after previous completes", async () => {
		// Create session with a stream that completes immediately
		const model = requireModel(getModel("anthropic", "claude-sonnet-4-5"));
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			},
		});

		session = new AgentSession({
			...sessionServices(agent),
			resourceLoader: createTestResourceLoader(),
		});

		// First prompt completes
		await session.prompt("First message");

		// Should not be streaming anymore
		expect(session.isStreaming).toBe(false);

		// Second prompt should work
		await expect(session.prompt("Second message")).resolves.not.toThrow();
	});

	it("should wait for queued agent events before emitting tool_call", async () => {
		const model = requireModel(getModel("anthropic", "claude-sonnet-4-5"));
		const tool = {
			name: "dummy",
			description: "Dummy tool",
			label: "dummy",
			parameters: Type.Object({ q: Type.String() }),
			execute: async (_toolCallId: string, params: unknown) => {
				const q =
					typeof params === "object" && params !== null && "q" in params
						? String((params as { q: unknown }).q)
						: "";
				return {
					content: [{ type: "text" as const, text: `result:${q}` }],
					details: {},
				};
			},
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [tool],
			},
			streamFn: async (_model, context) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const toolResultCount = context.messages.filter((message) => message.role === "toolResult").length;
					if (toolResultCount > 0) {
						const message: AssistantMessage = {
							role: "assistant",
							content: [{ type: "text", text: "done" }],
							api: "anthropic-messages",
							provider: "anthropic",
							model: "mock",
							usage: tokenUsage(1, 1),
							stopReason: "stop",
							timestamp: Date.now(),
						};
						stream.push({ type: "start", partial: { ...message, content: [] } });
						stream.push({ type: "done", reason: "stop", message });
						return;
					}

					const message: AssistantMessage = {
						role: "assistant",
						content: [
							{ type: "toolCall", id: "toolu_1", name: "dummy", arguments: { q: "x" } },
							{ type: "toolCall", id: "toolu_2", name: "dummy", arguments: { q: "y" } },
						],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "mock",
						usage: tokenUsage(1, 1),
						stopReason: "toolUse",
						timestamp: Date.now(),
					};

					stream.push({ type: "start", partial: { ...message, content: [] } });
					stream.push({ type: "done", reason: "toolUse", message });
				});
				return stream;
			},
		});

		session = new AgentSession({
			...sessionServices(agent),
			resourceLoader: createTestResourceLoader(),
			baseToolsOverride: { dummy: tool },
		});

		const snapshots: string[][] = [];
		agent.beforeToolCall = async () => {
			snapshots.push(
				session.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "message")
					.map((entry) => entry.message.role),
			);
			return undefined;
		};

		await session.prompt("hi");
		await session.agent.waitForIdle();

		expect(snapshots).toEqual([
			["user", "assistant"],
			["user", "assistant"],
		]);
	});

	it("should persist message_end events in order with slow extension handlers", async () => {
		const model = requireModel(getModel("anthropic", "claude-sonnet-4-5"));
		const tool = {
			name: "dummy",
			description: "Dummy tool",
			label: "dummy",
			parameters: Type.Object({ q: Type.String() }),
			execute: async (_toolCallId: string, params: unknown) => {
				const q =
					typeof params === "object" && params !== null && "q" in params
						? String((params as { q: unknown }).q)
						: "";
				return {
					content: [{ type: "text" as const, text: `result:${q}` }],
					details: {},
				};
			},
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [tool],
			},
			streamFn: async (_model, context) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const hasToolResult = context.messages.some((message) => message.role === "toolResult");

					if (hasToolResult) {
						const message = createCompletedAssistantMessage("done");
						stream.push({ type: "start", partial: { ...message, content: [] } });
						stream.push({ type: "done", reason: "toolUse", message });
						return;
					}

					const message: AssistantMessage = {
						role: "assistant",
						content: [
							{ type: "text", text: "calling tool" },
							{ type: "toolCall", id: "toolu_1", name: "dummy", arguments: { q: "x" } },
						],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "mock",
						usage: tokenUsage(1, 1),
						stopReason: "toolUse",
						timestamp: Date.now(),
					};

					stream.push({ type: "start", partial: { ...message, content: [] } });
					stream.push({ type: "done", reason: "toolUse", message });
				});
				return stream;
			},
		});

		session = new AgentSession({
			...sessionServices(agent),
			resourceLoader: createTestResourceLoader(),
			baseToolsOverride: { dummy: tool },
		});

		const sessionWithRunner = session as unknown as {
			_extensionRunner: {
				emitMessageEnd: (event: { type: string; message?: { role?: string } }) => Promise<undefined>;
			};
		};
		vi.spyOn(sessionWithRunner._extensionRunner, "emitMessageEnd").mockImplementation(async (event) => {
			if (event.type === "message_end" && event.message?.role === "assistant") {
				await new Promise((resolve) => setTimeout(resolve, 40));
			}
			return undefined;
		});

		await session.prompt("hi");
		await session.agent.waitForIdle();
		await new Promise((resolve) => setTimeout(resolve, 100));

		const messageEntries = session.sessionManager.getEntries().filter((entry) => entry.type === "message");
		expect(messageEntries.map((entry) => entry.message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
			"toolResult",
		]);
	});
});
