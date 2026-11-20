import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../../../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

function selectedModelId(selector: ModelSelectorComponent): string | undefined {
	const line = stripAnsi(selector.render(120).join("\n"))
		.split("\n")
		.find((l) => l.startsWith("→ "));
	return line?.replace(/^→\s*/, "").split(" [")[0]?.trim();
}

describe("issue #7209 model selector filter selects the top row", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function createSelector(scopedIds: string[]): Promise<ModelSelectorComponent> {
		const harness = await createHarness({
			models: [
				{ id: "alpha-1", name: "Alpha One", reasoning: true },
				{ id: "alpha-2", name: "Alpha Two", reasoning: true },
				{ id: "alpha-3", name: "Alpha Three", reasoning: true },
				{ id: "beta-1", name: "Beta One", reasoning: true },
			],
		});
		harnesses.push(harness);
		const model = (id: string) => {
			const found = harness.getModel(id);
			if (!found) throw new Error(`Missing faux model ${id}`);
			return found;
		};
		const selector = new ModelSelectorComponent(
			{ requestRender: () => {} } as unknown as TUI,
			model("alpha-1"),
			harness.session.modelRegistry,
			scopedIds.map((id) => ({ model: model(id) })),
			() => {},
			() => {},
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		return selector;
	}

	it("moves the selection to the first match in the all tab", async () => {
		const selector = await createSelector([]);
		expect(selectedModelId(selector)).toBe("alpha-1");
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		expect(selectedModelId(selector)).toBe("alpha-3");

		for (const char of "alpha") selector.handleInput(char);

		expect(selectedModelId(selector)).toBe("alpha-1");
		expect(stripAnsi(selector.render(120).join("\n"))).not.toContain("beta-1");
	});

	it("keeps the highlighted match when a cursor key leaves the query unchanged", async () => {
		const selector = await createSelector([]);
		for (const char of "alpha") selector.handleInput(char);
		selector.handleInput("\x1b[B");
		expect(selectedModelId(selector)).toBe("alpha-2");

		selector.handleInput("\x1b[D");

		expect(selectedModelId(selector)).toBe("alpha-2");
	});

	it("moves the selection to the first match in the scoped tab", async () => {
		// The current model alpha-1 is the third scoped entry, so the selection starts on row 2.
		const selector = await createSelector(["alpha-2", "alpha-3", "alpha-1"]);
		expect(selectedModelId(selector)).toBe("alpha-1");

		for (const char of "alpha") selector.handleInput(char);

		expect(selectedModelId(selector)).toBe("alpha-2");
	});
});
