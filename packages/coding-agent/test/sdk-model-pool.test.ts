import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

type CapturedCall = { provider: string; model: string; apiKey?: string; headers?: Record<string, string> };

function assistantMessage(model: Model<any>, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("createAgentSession pool models", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-pool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	function createRegistry(calls: CapturedCall[], authenticated: string[]) {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {},
				pools: { "deepseek-flash": ["opencode-go/deepseek-v4.1-flash", "deepseek/deepseek-flash"] },
			}),
		);
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		for (const provider of authenticated) authStorage.setRuntimeApiKey(provider, `${provider}-key`);
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		modelRegistry.registerProvider("pool-capture", {
			api: "pool-capture-api",
			streamSimple: (model, _context, options?: SimpleStreamOptions) => {
				calls.push({
					provider: model.provider,
					model: model.id,
					apiKey: options?.apiKey,
					headers: options?.headers,
				});
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					if (model.provider === "opencode-go") {
						const error = assistantMessage(model, {
							stopReason: "error",
							errorMessage: 'GoUsageLimitError: {"type":"GoUsageLimitError"}',
						});
						stream.push({ type: "start", partial: error });
						stream.push({ type: "error", reason: "error", error });
						return;
					}
					const message = assistantMessage(model, { content: [{ type: "text", text: "pooled" }] });
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		for (const [provider, id, baseUrl] of [
			["opencode-go", "deepseek-v4.1-flash", "https://opencode.ai/zen/go/v1"],
			["deepseek", "deepseek-flash", "https://api.deepseek.com"],
		]) {
			modelRegistry.registerProvider(provider, {
				baseUrl,
				apiKey: "$PI_TEST_MISSING_POOL_MEMBER_KEY",
				api: "pool-capture-api",
				models: [
					{
						id,
						name: id,
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 1_000_000,
						maxTokens: 384_000,
					},
				],
			});
		}
		return { authStorage, modelRegistry };
	}

	it("routes each pool member through the SDK request path with its own credentials and headers", async () => {
		const calls: CapturedCall[] = [];
		const { authStorage, modelRegistry } = createRegistry(calls, ["opencode-go", "deepseek"]);
		const pool = modelRegistry.find("pool", "deepseek-flash");
		if (!pool) throw new Error("pool/deepseek-flash did not load");
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.newSession({ id: "pool-session" });
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: pool,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.create(cwd, agentDir),
			sessionManager,
		});

		try {
			const stream = await session.agent.streamFn(pool, { messages: [] }, { sessionId: session.sessionId });
			const result = await stream.result();

			expect(calls.map((call) => `${call.provider}/${call.model}`)).toEqual([
				"opencode-go/deepseek-v4.1-flash",
				"deepseek/deepseek-flash",
			]);
			expect(calls.map((call) => call.apiKey)).toEqual(["opencode-go-key", "deepseek-key"]);
			expect(calls[0].headers?.["x-opencode-session"]).toBe("pool-session");
			expect(calls[1].headers?.["x-opencode-session"]).toBeUndefined();
			expect(result.provider).toBe("deepseek");
			expect(result.model).toBe("deepseek-flash");
			expect(result.content).toEqual([{ type: "text", text: "pooled" }]);
		} finally {
			session.dispose();
		}
	});

	it("reports pool request auth from its members", async () => {
		const authenticated = createRegistry([], ["deepseek"]).modelRegistry;
		const authenticatedPool = authenticated.find("pool", "deepseek-flash")!;
		await expect(authenticated.getApiKeyAndHeaders(authenticatedPool)).resolves.toMatchObject({ ok: true });

		const unauthenticated = createRegistry([], []).modelRegistry;
		const unauthenticatedPool = unauthenticated.find("pool", "deepseek-flash")!;
		await expect(unauthenticated.getApiKeyAndHeaders(unauthenticatedPool)).resolves.toEqual({
			ok: false,
			error: 'Pool "deepseek-flash": no member has configured authentication',
		});
	});
});
