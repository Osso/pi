import { Agent } from "@earendil-works/pi-agent-core";
import {
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { type Api, getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { getFirstPartyExtensionNames } from "../src/main.ts";
import { createTestResourceLoader, registerTestOllamaModel } from "./utilities.ts";

function createOpenAIActiveSession(options: { withOllama: boolean }) {
	const activeModel = getModel("openai", "gpt-4.1-mini")!;
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("openai", "openai-test-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const ollamaModel = options.withOllama ? registerTestOllamaModel(modelRegistry) : undefined;
	const settingsManager = SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } });
	const sessionManager = SessionManager.inMemory();
	const requestedModels: Array<{ provider: string; model: string }> = [];
	const agent = new Agent({
		getApiKey: () => "openai-test-key",
		initialState: {
			model: activeModel,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: (model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => {
			requestedModels.push({ provider: model.provider, model: model.id });
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage("ollama summary"),
						api: model.api,
						provider: model.provider,
						model: model.id,
					},
				});
			});
			return stream;
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRegistry,
		resourceLoader: createTestResourceLoader(),
	});
	return { session, sessionManager, requestedModels, ollamaModel };
}

function appendCompactableHistory(sessionManager: SessionManager, model: Model<Api>): void {
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "summarize me" }],
		timestamp: Date.now(),
	});
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "history" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 100,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 110,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

describe("Ollama-only compaction", () => {
	it("manual compaction uses a configured Ollama model when the active model is OpenAI", async () => {
		const { session, sessionManager, requestedModels, ollamaModel } = createOpenAIActiveSession({ withOllama: true });
		try {
			appendCompactableHistory(sessionManager, session.model!);
			session.agent.state.messages = sessionManager.buildSessionContext().messages;

			const result = await session.compact();

			expect(requestedModels).toEqual([{ provider: "ollama", model: "gpt-oss:20b" }]);
			expect(result.source).toEqual({ type: "local", provider: ollamaModel!.provider, model: ollamaModel!.id });
		} finally {
			session.dispose();
		}
	});

	it("manual compaction fails explicitly instead of falling back when no Ollama model is configured", async () => {
		const { session, sessionManager, requestedModels } = createOpenAIActiveSession({ withOllama: false });
		try {
			appendCompactableHistory(sessionManager, session.model!);
			session.agent.state.messages = sessionManager.buildSessionContext().messages;

			await expect(session.compact()).rejects.toThrow(/configured Ollama model/i);
			expect(requestedModels).toEqual([]);
		} finally {
			session.dispose();
		}
	});

	it("does not register the removed OpenAI remote compaction extension as first-party", () => {
		expect(getFirstPartyExtensionNames()).not.toContain("openai-remote-compact");
	});
});
