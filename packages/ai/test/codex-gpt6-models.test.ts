import { describe, expect, it } from "vitest";
import { getModels } from "../src/compat.ts";

for (const provider of ["openai-codex", "openai-codex-gc"] as const) {
	describe(`${provider} GPT-6 catalog`, () => {
		it.each([
			["gpt-6-sol", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
			["gpt-6-luna", { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }],
		] as const)("resolves %s with published limits and pricing", (id, cost) => {
			const model = getModels(provider).find((candidate) => candidate.id === id);
			expect(model).toMatchObject({
				id,
				provider,
				api: "openai-codex-responses",
				baseUrl: "https://chatgpt.com/backend-api",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 922000,
				maxTokens: 128000,
				thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
				cost,
			});
		});

		it("retains GPT-5.6 Sol and Luna selections", () => {
			const ids = getModels(provider).map((model) => model.id);
			expect(ids).toContain("gpt-5.6-sol");
			expect(ids).toContain("gpt-5.6-luna");
		});
	});
}
