import type { Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import effortExtension from "../../extensions/effort/src/index.ts";
import type { ViewedSessionMutationTarget } from "../../src/core/extensions/index.ts";
import type { ExtensionFactory } from "../../src/index.ts";
import { createHarness } from "./harness.ts";

describe("literal viewed-session command routing", () => {
	it("keeps unrelated model and effort setters local while routing model and effort to the viewed session", async () => {
		let harnessModel: Model<string> | undefined;
		let helperModel: Model<string> | undefined;
		const viewedSetModel = vi.fn(async () => {});
		const viewedSetThinkingLevel = vi.fn();
		const helperExtension: ExtensionFactory = (pi) => {
			pi.registerCommand("model-helper", {
				description: "Mutate the owning session",
				handler: async (_args, ctx) => {
					if (!helperModel) throw new Error("helper model not initialized");
					await ctx.setModel(helperModel);
					ctx.setThinkingLevel("low");
				},
			});
		};
		let harness: Awaited<ReturnType<typeof createHarness>>;
		harness = await createHarness({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: true },
			],
			extensionFactories: [effortExtension, helperExtension],
			resolveSessionMutationTarget: (): ViewedSessionMutationTarget => ({
				model: harnessModel,
				thinkingLevel: "medium",
				setModel: viewedSetModel,
				setThinkingLevel: viewedSetThinkingLevel,
				modelRegistry: harness.session.modelRegistry,
				scopedModels: harness.session.scopedModels,
			}),
		});
		try {
			harnessModel = harness.getModel("faux-1");
			helperModel = harness.getModel("faux-2");
			if (!harnessModel || !helperModel) throw new Error("expected harness models");

			await harness.session.prompt("/model-helper");
			expect(harness.session.model?.id).toBe("faux-2");
			expect(harness.session.thinkingLevel).toBe("low");
			expect(viewedSetModel).not.toHaveBeenCalled();
			expect(viewedSetThinkingLevel).not.toHaveBeenCalled();

			await harness.session.prompt("/model faux/faux-1");
			await harness.session.prompt("/effort high");
			expect(viewedSetModel).toHaveBeenCalledWith(harnessModel);
			expect(viewedSetThinkingLevel).toHaveBeenCalledWith("high");
		} finally {
			harness.cleanup();
		}
	});
});
