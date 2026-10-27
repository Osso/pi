/**
 * A child dispatch prompt that arrives while the child session is already running a turn.
 *
 * Restart recovery opens a `steering_pending` child; its runtime mailbox poll can deliver the pending
 * steering and start a turn before the dispatcher sends the recovery prompt. That prompt used to throw
 * "Agent is already processing" and the child was terminalized as failed (2026-10-27, seven children).
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
import { createTestResourceLoader } from "./utilities.ts";

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
	tempDir = join(tmpdir(), `pi-child-busy-${Date.now()}`);
	mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
	session?.dispose();
	session = undefined;
	if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
});

function createSession(): AgentSession {
	const seenPrompts: string[] = [];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: getModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: "Test", tools: [] },
		streamFn: (_model, context) => {
			const stream = new MockAssistantStream();
			const last = [...context.messages].reverse().find((message) => message.role === "user");
			const prompt = last && last.role === "user" ? text(last.content) : "";
			seenPrompts.push(prompt);
			// Each turn takes a little while, so a second prompt lands mid-turn.
			setTimeout(() => {
				stream.push({ type: "start", partial: completed("") });
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
		settingsManager: SettingsManager.create(tempDir, tempDir),
		cwd: tempDir,
		modelRegistry: ModelRegistry.create(authStorage, tempDir),
		resourceLoader: createTestResourceLoader(),
	});
	return session;
}

it("runs a dispatch prompt after the turn already in progress instead of failing", async () => {
	const live = createSession();
	const child = bindProductionChildSession(live as unknown as UnboundChildAgentSession);

	const pendingSteeringTurn = live.prompt("Delivered pending steering");
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(live.isStreaming).toBe(true);

	await child.prompt("Crash recovery prompt");

	// The dispatcher reads the child's result as soon as prompt resolves, so the recovery prompt must
	// have been answered by then.
	const replies = child.messages
		.filter((message) => message.role === "assistant")
		.map((message) => (message.role === "assistant" ? text(message.content as Array<TextContent>) : ""));
	expect(replies).toContain("answered Crash recovery prompt");
	expect(replies).toContain("answered Delivered pending steering");
	expect(live.isStreaming).toBe(false);
	await pendingSteeringTurn;
});
