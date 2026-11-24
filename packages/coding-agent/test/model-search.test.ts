import { describe, expect, it } from "vitest";
import { searchModels } from "../src/modes/interactive/model-search.ts";

const models = [
	{ provider: "openai-codex", id: "gpt-5.4" },
	{ provider: "openai", id: "gpt-5.4" },
	{ provider: "openrouter", id: "openai/gpt-5.4" },
];

const references = (query: string) =>
	searchModels(models, query, (model) => model).map(({ provider, id }) => `${provider}/${id}`);

describe("model search", () => {
	it("ranks the model named by an exact provider/id reference first", () => {
		// Fuzzy scores tie for providers sharing a prefix, so list order used to pick openai-codex here.
		expect(references("openai/gpt-5.4")[0]).toBe("openai/gpt-5.4");
		expect(references("OpenAI-Codex/GPT-5.4")[0]).toBe("openai-codex/gpt-5.4");
	});

	it("keeps fuzzy matches for partial queries", () => {
		expect(references("codex 5.4")).toEqual(["openai-codex/gpt-5.4"]);
		expect(references("gpt-5.4")).toHaveLength(3);
	});
});
