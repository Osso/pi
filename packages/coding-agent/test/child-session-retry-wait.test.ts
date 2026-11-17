/**
 * A child dispatch prompt must not resolve while the session still owes it an automatic retry.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { fauxToolCall } from "@earendil-works/pi-ai";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type ImageContent,
	type TextContent,
} from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	bindProductionChildSession,
	type UnboundChildAgentSession,
} from "../extensions/agents-core/src/child-session.ts";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { assertDefined, createTestResourceLoader } from "./utilities.ts";

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

function text(content: string | Array<TextContent | ImageContent>): string {
	if (typeof content === "string") return content;
	return content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function completed(reply: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: reply }, fauxToolCall("end_turn", { reason: reply })],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

let tempDir: string;
let session: AgentSession | undefined;

beforeEach(() => {
	tempDir = join(tmpdir(), `pi-child-retry-${Date.now()}`);
	mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
	session?.dispose();
	session = undefined;
	if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
});

/** Every turn takes 30 ms; the first request for `failOnce` ends with a retryable transport error. */
function createSession(failOnce: string): AgentSession {
	let failed = false;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: assertDefined(getModel("anthropic", "claude-sonnet-4-5")),
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: (_model, context) => {
			const stream = new MockAssistantStream();
			const last = [...context.messages].reverse().find((message) => message.role === "user");
			const prompt = last && last.role === "user" ? text(last.content) : "";
			setTimeout(() => {
				stream.push({ type: "start", partial: completed("") });
				if (prompt === failOnce && !failed) {
					failed = true;
					const error: AssistantMessage = { ...completed(""), content: [], stopReason: "error" };
					stream.push({
						type: "error",
						reason: "error",
						error: { ...error, errorMessage: "WebSocket closed 1000" },
					});
					return;
				}
				stream.push({ type: "done", reason: "toolUse", message: completed(`answered ${prompt}`) });
			}, 30);
			return stream;
		},
	});
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } }),
		cwd: tempDir,
		modelRegistry: ModelRegistry.create(authStorage, tempDir),
		resourceLoader: createTestResourceLoader(),
	});
	return session;
}

// 2026-11-17: an attached child's prompt was queued behind a running turn. When its request failed with
// "WebSocket closed 1000", promptChildTurn returned as soon as the agent went idle, before the session's
// auto-retry ran, so the dispatcher read the error as the child's result and failed the child.
it("waits for the session's auto-retry before a queued child prompt resolves", async () => {
	const live = createSession("Child task");
	const child = bindProductionChildSession(live as unknown as UnboundChildAgentSession);

	const runningTurn = live.prompt("Turn already running");
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(live.isStreaming).toBe(true);

	await child.prompt("Child task");

	const last = [...child.messages].reverse().find((message) => message.role === "assistant");
	expect(last?.role === "assistant" && last.stopReason).toBe("toolUse");
	expect(last?.role === "assistant" && text(last.content as Array<TextContent>)).toBe("answered Child task");
	await runningTurn;
});
