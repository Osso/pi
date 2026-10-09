import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const diagnostic = {
	phase: "error" as const,
	timestamp: 1791525600000,
	elapsedMs: 42,
	transport: "websocket" as const,
	attempt: 1,
	failureKind: "api" as const,
	upstreamErrorCode: "server_error",
	requestId: "13b5c7b6-a625-40c7-bcd5-295dd5895a75",
};
const sensitive = "secret-prompt-body-cookie-authorization-token";

function response(model: Model<Api>, error: boolean): AssistantMessage {
	return {
		role: "assistant",
		content: error ? [] : [{ type: "text", text: "ok" }],
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
		stopReason: error ? "error" : "stop",
		...(error ? { errorMessage: `An error occurred. You can retry your request. ${sensitive}` } : {}),
		timestamp: Date.now(),
	};
}

describe("SDK provider diagnostics", () => {
	let directory: string;
	const disposals: Array<() => void> = [];
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-sdk-diagnostics-"));
	});
	afterEach(() => {
		for (const dispose of disposals.splice(0)) dispose();
		rmSync(directory, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	async function fixture(options: { api?: Api; failLog?: boolean; retry?: boolean; providerRetry?: boolean } = {}) {
		const cwd = join(directory, "project");
		const agentDir = join(directory, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		if (options.failLog) writeFileSync(join(agentDir, "logs"), sensitive);
		const model: Model<Api> = {
			id: "capture-model",
			name: "Capture Model",
			api: options.api ?? "openai-codex-responses",
			provider: "diagnostics-capture",
			baseUrl: "https://capture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, sensitive);
		const registry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		let calls = 0;
		registry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: (callbackModel, _context, requestOptions) => {
				calls++;
				requestOptions?.onDiagnostic?.(Object.assign({}, diagnostic, { payload: sensitive }), callbackModel);
				if (options.providerRetry)
					requestOptions?.onRetry?.({ attempt: 2, maxAttempts: 3, delayMs: 7, reason: sensitive }, callbackModel);
				const message = response(callbackModel, true);
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "start", partial: message });
				stream.push({ type: "error", reason: "error", error: message });
				return stream;
			},
		});
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRegistry: registry,
			sessionManager,
			noSupervisor: true,
			noTools: "all",
			settingsManager: SettingsManager.inMemory({
				retry: { enabled: options.retry ?? false, maxRetries: 1, baseDelayMs: 0 },
			}),
		});
		disposals.push(() => {
			session.dispose();
			registry.unregisterProvider(model.provider);
		});
		const file = join(agentDir, "logs", "provider-diagnostics", "codex.jsonl");
		return { session, sessionManager, model, file, calls: () => calls };
	}

	it("correlates failures, excludes request content, and preserves caller callbacks and error results", async () => {
		const { session, sessionManager, model, file } = await fixture();
		let notifications = 0;
		const options: SimpleStreamOptions = {
			onDiagnostic: () => {
				notifications++;
			},
			headers: { Authorization: sensitive },
		};
		for (let i = 0; i < 2; i++) {
			const stream = await session.agent.streamFn(
				model,
				{ messages: [{ role: "user", content: sensitive, timestamp: 0 }] },
				options,
			);
			expect((await stream.result()).errorMessage).toContain(sensitive);
		}
		expect(notifications).toBe(2);
		const text = readFileSync(file, "utf8");
		expect(text).not.toContain(sensitive);
		const records = text
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records.map((record) => record.logicalRequestNumber)).toEqual([1, 2]);
		expect(records[0]).toMatchObject({
			...diagnostic,
			provider: model.provider,
			model: model.id,
			sessionId: sessionManager.getSessionId(),
		});
	});

	it("records provider retry metadata without its raw reason", async () => {
		const { session, model, file } = await fixture({ providerRetry: true });
		let retries = 0;
		const stream = await session.agent.streamFn(
			model,
			{ messages: [] },
			{
				onRetry: () => {
					retries++;
				},
			},
		);
		await stream.result();
		expect(retries).toBe(1);
		const text = readFileSync(file, "utf8");
		expect(text).not.toContain(sensitive);
		expect(JSON.parse(text.trim().split("\n")[1])).toMatchObject({
			phase: "retry",
			retryLayer: "provider",
			attempt: 2,
			maxAttempts: 3,
			delayMs: 7,
			logicalRequestNumber: 1,
		});
	});

	it("records session retry exhaustion without changing its request count or final error", async () => {
		const { session, file, calls } = await fixture({ retry: true });
		await session.prompt(sensitive);
		expect(calls()).toBe(2);
		const records = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records.map((record) => record.phase)).toEqual(["error", "retry", "error"]);
		expect(records[1]).toMatchObject({
			retryLayer: "session",
			attempt: 2,
			maxAttempts: 2,
			delayMs: 0,
			logicalRequestNumber: 1,
		});
		expect(session.agent.state.messages.at(-1)).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining(sensitive),
		});
	});

	it("does not create diagnostics for other provider APIs", async () => {
		const { session, model, file } = await fixture({ api: "openai-completions" });
		await (await session.agent.streamFn(model, { messages: [] })).result();
		expect(existsSync(file)).toBe(false);
	});

	it("contains write failures and warns only once without leaking error data", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { session, model } = await fixture({ failLog: true });
		for (let i = 0; i < 2; i++) {
			const result = await (await session.agent.streamFn(model, { messages: [] })).result();
			expect(result.errorMessage).toContain(sensitive);
		}
		expect(warning.mock.calls).toEqual([["Provider diagnostics could not be written."]]);
	});
});
