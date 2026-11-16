import assert from "node:assert";
import { describe, it } from "node:test";
import { Input } from "../src/components/input.ts";
import { SelectList } from "../src/components/select-list.ts";
import { SettingsList } from "../src/components/settings-list.ts";
import { visibleWidth } from "../src/utils.ts";
import { defaultSelectListTheme } from "./test-themes.ts";

const identity = (text: string) => text;
const settingsTheme = { label: identity, value: identity, description: identity, cursor: "→ ", hint: identity };
const settingItems = [
	{ id: "compact", label: "Auto compact", description: "Compact the context when it fills", currentValue: "true" },
	{ id: "theme", label: "Theme", currentValue: "dark" },
];

const components: Array<[string, () => { render(width: number): string[] }]> = [
	["Input", () => new Input()],
	[
		"SelectList",
		() => new SelectList([{ value: "x", label: "Option x", description: "desc" }], 5, defaultSelectListTheme),
	],
	[
		"SettingsList",
		() =>
			new SettingsList(
				settingItems,
				5,
				settingsTheme,
				() => {},
				() => {},
			),
	],
	[
		"SettingsList with search",
		() =>
			new SettingsList(
				settingItems,
				5,
				settingsTheme,
				() => {},
				() => {},
				{ enableSearch: true },
			),
	],
];

describe("components at 1- to 3-column widths", () => {
	for (const [name, create] of components) {
		it(`${name} renders no line wider than the terminal`, () => {
			for (const width of [1, 2, 3]) {
				const tooWide = create()
					.render(width)
					.filter((line) => visibleWidth(line) > width);
				assert.deepStrictEqual(tooWide, [], `width ${width}`);
			}
		});
	}

	it("SettingsList keeps the selected description readable at width 1", () => {
		const lines = new SettingsList(
			settingItems,
			5,
			settingsTheme,
			() => {},
			() => {},
		).render(1);
		assert.ok(lines.join("").includes("Compact"));
	});
});
