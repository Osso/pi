import { describe, expect, it } from "vitest";
import { getImageModel, getImageModels, getImageProviders } from "../src/image-models.ts";

const provider = "openrouter";
const modelId = "google/gemini-2.5-flash-image";

describe("image model catalog copy-on-read", () => {
	it.each(["single", "list"])("isolates nested mutations through the %s getter", (getter) => {
		const original = structuredClone(getImageModel(provider, modelId));
		const model =
			getter === "single"
				? getImageModel(provider, modelId)
				: getImageModels(provider).find((item) => item.id === modelId);
		if (!model) throw new Error("Fixture model missing");
		try {
			model.name = "caller-owned name";
			model.input.length = 0;
			model.output.length = 0;
			model.cost.input = 999;
			expect(getImageModel(provider, modelId)).toEqual(original);
			expect(getImageModels(provider).find((item) => item.id === modelId)).toEqual(original);
		} finally {
			// Keep the RED run independent of test ordering even with the broken shared registry.
			Object.assign(model, original);
		}
	});

	it("returns independent provider and model lists", () => {
		const providers = getImageProviders();
		const models = getImageModels(provider);
		const originalProviders = [...providers];
		const originalCount = models.length;
		providers.length = 0;
		models.length = 0;
		expect(getImageProviders()).toEqual(originalProviders);
		expect(getImageModels(provider)).toHaveLength(originalCount);
	});
});
