import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { resolveCliModel } from "../src/core/model-resolver.ts";

const legacyModelId = "gemini-3.8-pro";
const oldGeminiModelIds = ["gemini-2.5-pro", "gemini-3-pro-preview", legacyModelId];
const previewModelId = "x-gemini-3.8-pro-preview";
const openRouterLegacyModelId = "google/gemini-3.8-pro";
const neonModelId = "gemini-4-neon";
const hydrogenModelId = "gemini-4-hydrogen";
const unrelatedModelId = "claude-sonnet-4-5";
const fixtureProvider = "fixture-google";
const literalProvider = "literal-models";
const sameIdProvider = "other-gateway";
const modelIds = [...oldGeminiModelIds, previewModelId, neonModelId, hydrogenModelId, unrelatedModelId];

function modelDefinition(id: string, limits?: { contextWindow: number; maxTokens: number }) {
	return {
		id,
		name: id,
		reasoning: true,
		input: ["text"],
		contextWindow: limits?.contextWindow ?? 128000,
		maxTokens: limits?.maxTokens ?? 8192,
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
	};
}

describe("disabled model selection", () => {
	let tempDir: string;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	function createRegistry(options?: { allFixtureModelsDisabled?: boolean; duplicateLegacyId?: boolean }) {
		tempDir = mkdtempSync(join(tmpdir(), "pi-disabled-models-"));
		const modelsPath = join(tempDir, "models.json");
		const fixtureModelIds = options?.allFixtureModelsDisabled ? [legacyModelId] : modelIds;
		const providers: Record<string, unknown> = {
			[fixtureProvider]: {
				baseUrl: "https://models.invalid/v1",
				api: "openai-completions",
				apiKey: "fixture-key",
				models: fixtureModelIds.map((id) =>
					id === legacyModelId
						? modelDefinition(id, { contextWindow: 2048, maxTokens: 1024 })
						: modelDefinition(id),
				),
				disabledModels: options?.allFixtureModelsDisabled
					? ["*"]
					: ["gemini-2.*", "gemini-3-*", "gemini-3.[0-8]-*"],
			},
		};
		providers.openrouter = {
			baseUrl: "https://openrouter.invalid/api/v1",
			api: "openai-completions",
			apiKey: "fixture-key",
			models: [modelDefinition(openRouterLegacyModelId)],
			disabledModels: ["google/gemini-3.[0-8]-*"],
		};
		providers[literalProvider] = {
			baseUrl: "https://literal.invalid/v1",
			api: "openai-completions",
			apiKey: "fixture-key",
			models: [modelDefinition(`${legacyModelId}:high`)],
			disabledModels: [legacyModelId],
		};
		if (options?.duplicateLegacyId) {
			providers[sameIdProvider] = {
				baseUrl: "https://gateway.invalid/v1",
				api: "openai-completions",
				apiKey: "fixture-key",
				models: [modelDefinition(legacyModelId)],
			};
		}
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers,
				pools: {
					usable: [`${fixtureProvider}/${legacyModelId}`, `${fixtureProvider}/${hydrogenModelId}`],
					legacyOnly: [`${fixtureProvider}/${legacyModelId}`],
				},
			}),
		);
		return ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
	}

	test("filters old Gemini IDs from all and available catalogs but keeps Neon, Hydrogen, and unrelated models", () => {
		const registry = createRegistry();
		const allIds = registry
			.getAll()
			.filter((model) => model.provider === fixtureProvider)
			.map((model) => model.id);
		const availableIds = registry
			.getAvailable()
			.filter((model) => model.provider === fixtureProvider)
			.map((model) => model.id);

		for (const ids of [allIds, availableIds]) {
			for (const disabledId of oldGeminiModelIds) expect(ids).not.toContain(disabledId);
			expect(ids).toEqual(expect.arrayContaining([previewModelId, neonModelId, hydrogenModelId, unrelatedModelId]));
		}
		expect(registry.getAll().some((model) => model.id === openRouterLegacyModelId)).toBe(false);
	});

	test("keeps a usable pool member, removes disabled members, and skips an all-disabled pool", () => {
		const registry = createRegistry();
		const usablePool = registry.find("pool", "usable");

		expect(usablePool).toBeDefined();
		if (!usablePool) throw new Error("usable pool should resolve");
		expect(usablePool.contextWindow).toBe(128000);
		expect(usablePool.maxTokens).toBe(8192);
		expect(registry.hasConfiguredAuth(usablePool)).toBe(true);
		expect(registry.getAvailable()).toContain(usablePool);
		expect(registry.find("pool", "legacyOnly")).toBeUndefined();
		expect(registry.getError()).toContain('Pool "legacyOnly": no members resolve');
	});

	test("rejects disabled provider/model selections, including case variants and thinking suffixes", () => {
		const registry = createRegistry({ allFixtureModelsDisabled: true });
		expect(registry.getAll().some((model) => model.provider === fixtureProvider)).toBe(false);
		for (const options of [
			{ cliProvider: "FIXTURE-GOOGLE", cliModel: legacyModelId },
			{ cliProvider: fixtureProvider, cliModel: `${fixtureProvider}/${legacyModelId}` },
			{ cliModel: `${fixtureProvider}/${legacyModelId}` },
			{ cliModel: `${fixtureProvider}/${legacyModelId}:high` },
			{ cliProvider: fixtureProvider, cliModel: `${legacyModelId}:high`, cliThinking: "low" as const },
		]) {
			const result = resolveCliModel({ ...options, modelRegistry: registry });
			expect(result.model).toBeUndefined();
			expect(result.error).toBe(
				`Model "${fixtureProvider}/${legacyModelId}${options.cliModel?.endsWith(":high") ? ":high" : ""}" not found. Use --list-models to see available models.`,
			);
		}
	});

	test("keeps an available literal colon ID when only its stripped base ID is disabled", () => {
		const registry = createRegistry();
		const literalId = `${legacyModelId}:high`;
		const result = resolveCliModel({ cliProvider: literalProvider, cliModel: literalId, modelRegistry: registry });

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe(literalProvider);
		expect(result.model?.id).toBe(literalId);
	});

	test("rejects disabled slash-bearing IDs and custom fallback IDs", () => {
		const registry = createRegistry();
		for (const options of [
			{ cliProvider: "openrouter", cliModel: openRouterLegacyModelId },
			{ cliModel: `openrouter/${openRouterLegacyModelId}` },
			{ cliProvider: "openrouter", cliModel: "google/gemini-3.8-unlisted" },
		]) {
			const result = resolveCliModel({ ...options, modelRegistry: registry });
			expect(result.model).toBeUndefined();
			expect(result.error).toContain("not found. Use --list-models to see available models.");
		}
	});

	test("rejects a disabled exact ID before a fuzzy-only available candidate", () => {
		const registry = createRegistry();
		const result = resolveCliModel({
			cliProvider: fixtureProvider,
			cliModel: legacyModelId,
			modelRegistry: registry,
		});

		expect(registry.getAll().some((model) => model.id === previewModelId)).toBe(true);
		expect(result.model).toBeUndefined();
		expect(result.error).toBe(
			`Model "${fixtureProvider}/${legacyModelId}" not found. Use --list-models to see available models.`,
		);
	});

	test("preserves a bare exact ID that remains available on another provider", () => {
		const registry = createRegistry({ duplicateLegacyId: true });
		const result = resolveCliModel({ cliModel: legacyModelId, modelRegistry: registry });

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe(sameIdProvider);
		expect(result.model?.id).toBe(legacyModelId);
	});

	test("rejects a bare known disabled ID before fuzzy matching", () => {
		const registry = createRegistry();
		const result = resolveCliModel({ cliModel: legacyModelId, modelRegistry: registry });

		expect(result.model).toBeUndefined();
		expect(result.error).toBe(`Model "${legacyModelId}" not found. Use --list-models to see available models.`);
	});

	test("keeps ordinary fuzzy selection and custom-provider fallback behavior", () => {
		const registry = createRegistry();
		const fuzzy = resolveCliModel({ cliProvider: fixtureProvider, cliModel: "hydrogen", modelRegistry: registry });
		const fallback = resolveCliModel({
			cliProvider: fixtureProvider,
			cliModel: "unlisted-custom-model",
			modelRegistry: registry,
		});
		const unmatched = resolveCliModel({ cliModel: "unmatched-model-id", modelRegistry: registry });

		expect(fuzzy.model?.id).toBe(hydrogenModelId);
		expect(fallback.model?.id).toBe("unlisted-custom-model");
		expect(fallback.warning).toContain("Using custom model id");
		expect(unmatched.error).toBe('Model "unmatched-model-id" not found. Use --list-models to see available models.');
	});
});
