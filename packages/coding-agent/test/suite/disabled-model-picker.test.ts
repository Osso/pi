import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, expect, it } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness } from "./harness.ts";

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

it("hides a newly disabled model even when it remains in the picker scope", async () => {
	const harness = await createHarness({
		models: [{ id: "gemini-3.7-flash" }, { id: "gemini-4-neon" }],
		pools: {},
	});
	try {
		const oldModel = harness.getModel("gemini-3.7-flash");
		if (!oldModel) throw new Error("Missing scoped faux model");
		writeFileSync(
			join(harness.tempDir, "models.json"),
			JSON.stringify({ providers: { [oldModel.provider]: { disabledModels: ["gemini-3.*"] } } }),
		);
		const selector = await new Promise<ModelSelectorComponent>((resolve) => {
			const picker = new ModelSelectorComponent(
				{ requestRender: () => resolve(picker) } as unknown as TUI,
				oldModel,
				harness.session.modelRegistry,
				[{ model: oldModel }],
				() => {},
				() => {},
			);
		});

		const render = () => stripAnsi(selector.render(120).join("\n"));
		expect(render()).toContain("No matching models");
		expect(render()).not.toContain("gemini-3.7-flash");

		selector.handleInput("\t");

		expect(render()).toContain("gemini-4-neon");
		expect(render()).not.toContain("gemini-3.7-flash");
	} finally {
		harness.cleanup();
	}
});

it("drops a scoped pool whose only member became disabled", async () => {
	const harness = await createHarness({
		models: [{ id: "gemini-3.7-flash" }, { id: "gemini-4-neon" }],
		pools: { "only-old": ["faux/gemini-3.7-flash"] },
	});
	try {
		const neon = harness.getModel("gemini-4-neon");
		const pool = harness.session.modelRegistry.find("pool", "only-old");
		if (!neon || !pool) throw new Error("Missing scoped faux model or pool");
		writeFileSync(
			join(harness.tempDir, "models.json"),
			JSON.stringify({
				providers: { [neon.provider]: { disabledModels: ["gemini-3.*"] } },
				pools: { "only-old": [`${neon.provider}/gemini-3.7-flash`] },
			}),
		);
		const selector = await new Promise<ModelSelectorComponent>((resolve) => {
			const picker = new ModelSelectorComponent(
				{ requestRender: () => resolve(picker) } as unknown as TUI,
				neon,
				harness.session.modelRegistry,
				[{ model: neon }, { model: pool }],
				() => {},
				() => {},
			);
		});

		const render = stripAnsi(selector.render(120).join("\n"));
		expect(render).toContain("gemini-4-neon");
		expect(render).not.toContain("only-old [pool]");
		expect(render).toContain('Pool "only-old": no members resolve');
	} finally {
		harness.cleanup();
	}
});
