import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createSupervisorInstructionEvaluator } from "../src/supervisor/request-evaluation.ts";

const mocks = vi.hoisted(() => ({
	agentDir: "",
	authenticatedProviders: new Set<string>(),
	streamResults: [] as Array<{ provider: string; stopReason: string; errorMessage?: string; text?: string }>,
	streamedProviders: [] as string[],
}));

vi.mock("../src/core/auth-storage.ts", () => ({
	AuthStorage: { create: vi.fn(() => ({})) },
}));

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return {
		...actual,
		streamSimple: (model: { provider: string }) => ({
			result: async () => {
				mocks.streamedProviders.push(model.provider);
				const result = mocks.streamResults.find((candidate) => candidate.provider === model.provider);
				if (!result) throw new Error(`Unexpected Supervisor request to ${model.provider}`);
				return {
					content: result.text ? [{ text: result.text, type: "text" }] : [],
					errorMessage: result.errorMessage,
					provider: model.provider,
					stopReason: result.stopReason,
				};
			},
		}),
	};
});

vi.mock("../src/core/model-registry.ts", () => ({
	ModelRegistry: {
		create: () => ({
			find: (provider: string, id: string) =>
				(provider.startsWith("openai-codex") && id === "gpt-6.1-sol") ||
				(provider === "openrouter" && id === "deepseek/deepseek-v4.1-flash-1017")
					? { baseUrl: "https://example.test", id, provider }
					: undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
			hasConfiguredAuth: (model: { provider: string }) => mocks.authenticatedProviders.has(model.provider),
		}),
	},
}));

function createEvaluator() {
	const modelRegistry = ModelRegistry.create(AuthStorage.create(join(mocks.agentDir, "auth.json")));
	return createSupervisorInstructionEvaluator(modelRegistry, mocks.agentDir, mocks.agentDir);
}

describe("Supervisor instruction evaluator model selection", () => {
	beforeEach(() => {
		mocks.agentDir = mkdtempSync(join(tmpdir(), "pi-supervisor-evaluator-"));
		mocks.authenticatedProviders = new Set(["openai-codex"]);
		mocks.streamResults = [];
		mocks.streamedProviders = [];
	});

	afterEach(() => {
		rmSync(mocks.agentDir, { force: true, recursive: true });
	});

	it("fails when no Codex provider is authenticated", () => {
		mocks.authenticatedProviders = new Set();
		expect(() => createEvaluator()).toThrow(
			"Pi Supervisor requires gpt-6.1-sol on an authenticated provider: openai-codex, openai-codex-gc, openai-codex-team",
		);
	});

	it("uses the configured supervisorModel for instruction review", async () => {
		mocks.authenticatedProviders = new Set(["openai-codex", "openrouter"]);
		writeFileSync(
			join(mocks.agentDir, "settings.json"),
			JSON.stringify({ supervisorModel: "openrouter/deepseek/deepseek-v4.1-flash-1017" }),
		);
		mocks.streamResults = [{ provider: "openrouter", stopReason: "stop", text: '{"decision":"accept"}' }];

		const evaluate = createEvaluator();
		await expect(evaluate("continue", new AbortController().signal)).resolves.toBe('{"decision":"accept"}');
		expect(mocks.streamedProviders).toEqual(["openrouter"]);
	});

	it("fails when the configured supervisorModel is not authenticated", () => {
		mocks.authenticatedProviders = new Set(["openai-codex"]);
		writeFileSync(
			join(mocks.agentDir, "settings.json"),
			JSON.stringify({ supervisorModel: "openrouter/deepseek/deepseek-v4.1-flash-1017" }),
		);
		expect(() => createEvaluator()).toThrow(
			'Pi Supervisor supervisorModel "openrouter/deepseek/deepseek-v4.1-flash-1017" is not an authenticated provider/modelId',
		);
	});

	it("falls back to the next authenticated Codex provider when instruction review exhausts quota", async () => {
		mocks.authenticatedProviders = new Set(["openai-codex-gc", "openai-codex-team"]);
		mocks.streamResults = [
			{ provider: "openai-codex-gc", stopReason: "error", errorMessage: "You have hit your usage limit." },
			{ provider: "openai-codex-team", stopReason: "stop", text: '{"decision":"accept"}' },
		];
		const evaluate = createEvaluator();

		await expect(evaluate("continue", new AbortController().signal)).resolves.toBe('{"decision":"accept"}');
		expect(mocks.streamedProviders).toEqual(["openai-codex-gc", "openai-codex-team"]);
	});

	it("does not fall back for non-quota instruction review errors", async () => {
		mocks.authenticatedProviders = new Set(["openai-codex", "openai-codex-gc"]);
		mocks.streamResults = [{ provider: "openai-codex", stopReason: "error", errorMessage: "500 internal error" }];
		const evaluate = createEvaluator();

		await expect(evaluate("continue", new AbortController().signal)).resolves.toBeUndefined();
		expect(mocks.streamedProviders).toEqual(["openai-codex"]);
	});
});
