import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { resolveModelScopeWithDiagnostics } from "../src/core/model-resolver.ts";

const models: Model<"openai-completions">[] = ["sonnet-simple", "vendor/sonnet-large"].map((id) => ({
	id,
	name: id,
	provider: "scope-fixture",
	api: "openai-completions",
	baseUrl: "https://example.invalid/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
}));

describe("model scope identifiers", () => {
	test.each(["*sonnet*", "scope-fixture/*sonnet*", "*SONNET*:high", "scope-fixture/*sonnet*:high"])(
		"matches slash-containing IDs with %s",
		async (pattern) => {
			const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
			vi.spyOn(registry, "getAvailable").mockResolvedValue(models);
			const { models: patterns = [] } = parseArgs(["--models", pattern]);
			const result = await resolveModelScopeWithDiagnostics(patterns, registry);

			expect(result.diagnostics).toEqual([]);
			expect(result.scopedModels.map(({ model }) => model.id)).toEqual(["sonnet-simple", "vendor/sonnet-large"]);
			expect(result.scopedModels.map(({ thinkingLevel }) => thinkingLevel)).toEqual(
				pattern.endsWith(":high") ? ["high", "high"] : [undefined, undefined],
			);
		},
	);

	test.each(["vendor/sonnet-large", "scope-fixture/vendor/sonnet-large:high", "scope-fixture/vendor/sonnet-?arge"])(
		"preserves literal slash matching with %s",
		async (pattern) => {
			const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
			vi.spyOn(registry, "getAvailable").mockResolvedValue(models);
			const result = await resolveModelScopeWithDiagnostics([pattern], registry);

			expect(result.diagnostics).toEqual([]);
			expect(result.scopedModels.map(({ model }) => model.id)).toEqual(["vendor/sonnet-large"]);
			expect(result.scopedModels[0]?.thinkingLevel).toBe(pattern.endsWith(":high") ? "high" : undefined);
		},
	);

	test("keeps an exact id that two providers share instead of matching a longer id", async () => {
		const shared = ["alpha-provider", "beta-provider"].flatMap((provider) =>
			["gpt-x", "gpt-x-pro"].map((id) => ({ ...models[0], id, name: id, provider })),
		);
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		vi.spyOn(registry, "getAvailable").mockResolvedValue(shared);
		const result = await resolveModelScopeWithDiagnostics(["gpt-x:high"], registry);

		expect(result.scopedModels.map(({ model }) => model.id)).toEqual(["gpt-x"]);
		expect(result.scopedModels[0]?.thinkingLevel).toBe("high");
	});

	test("matches a provider-prefixed fuzzy pattern within that provider", async () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		vi.spyOn(registry, "getAvailable").mockResolvedValue(models);
		const result = await resolveModelScopeWithDiagnostics(["scope-fixture/simple:high"], registry);

		expect(result.diagnostics).toEqual([]);
		expect(result.scopedModels.map(({ model, thinkingLevel }) => [model.id, thinkingLevel])).toEqual([
			["sonnet-simple", "high"],
		]);
	});

	test("keeps a glob whose thinking level suffix is misspelled and warns", async () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		vi.spyOn(registry, "getAvailable").mockResolvedValue(models);
		const result = await resolveModelScopeWithDiagnostics(["*simple*:hgih"], registry);

		expect(result.scopedModels.map(({ model, thinkingLevel }) => [model.id, thinkingLevel])).toEqual([
			["sonnet-simple", undefined],
		]);
		expect(result.diagnostics.map(({ message }) => message)).toEqual([
			'Invalid thinking level "hgih" in pattern "*simple*:hgih". Using default instead.',
		]);
	});
});
