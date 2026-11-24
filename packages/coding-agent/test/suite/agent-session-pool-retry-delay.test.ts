import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSession } from "../../src/core/sdk.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("model pool retry delay", () => {
	const harnesses: Harness[] = [];
	const sessions: Array<{ dispose: () => void }> = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (sessions.length > 0) {
			sessions.pop()?.dispose();
		}
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("honors the configured retry-delay cap for manual compaction", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const harness = await createHarness({
			fauxProvider: { api: "faux-pool-member", provider: "faux-pool-member" },
			models: [{ id: "first" }, { id: "second" }],
			pools: { cooldown: ["faux-pool-member/first", "faux-pool-member/second"] },
			settings: {
				compaction: { keepRecentMessages: 1 },
				retry: { provider: { maxRetryDelayMs: 120_000 } },
			},
		});
		harnesses.push(harness);
		const pool = harness.session.modelRegistry.find("pool", "cooldown");
		if (!pool) throw new Error("Missing pool/cooldown");

		const model = harness.getModel();
		const now = Date.now();
		const appendAssistant = (timestamp: number, text: string) => {
			const message = fauxAssistantMessage(text, { timestamp });
			message.api = model.api;
			message.provider = model.provider;
			message.model = model.id;
			message.usage = {
				input: 100,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			harness.sessionManager.appendMessage(message);
		};
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "older message to compact" }],
			timestamp: now - 3000,
		});
		appendAssistant(now - 2500, "older assistant response");
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "message to compact" }],
			timestamp: now - 1000,
		});
		appendAssistant(now - 500, "assistant response to compact");

		const { session } = await createAgentSession({
			noSupervisor: true,
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			model: pool,
			settingsManager: harness.settingsManager,
			sessionManager: harness.sessionManager,
			resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);

		const requestedModels: string[] = [];
		harness.setResponses([
			(_context, _options, _state, requestModel) => {
				requestedModels.push(requestModel.id);
				const rateLimit = fauxAssistantMessage([], {
					stopReason: "error",
					errorMessage: "429 rate limit reached",
				});
				rateLimit.retryAfterMs = 90_000;
				return rateLimit;
			},
			(_context, _options, _state, requestModel) => {
				requestedModels.push(requestModel.id);
				return fauxAssistantMessage("compaction summary");
			},
			(_context, _options, _state, requestModel) => {
				requestedModels.push(requestModel.id);
				return fauxAssistantMessage("turn-prefix summary");
			},
			(_context, _options, _state, requestModel) => {
				requestedModels.push(requestModel.id);
				return fauxAssistantMessage("after cooldown");
			},
		]);

		const compaction = await session.compact();
		expect(compaction.summary).toContain("compaction summary");
		expect(compaction.summary).toContain("turn-prefix summary");
		expect(requestedModels).toEqual(["first", "second", "second"]);

		vi.setSystemTime(Date.now() + 90_001);
		await session.prompt("prompt after rate-limit cooldown");

		expect(requestedModels.at(-1)).toBe("first");
	});
});
