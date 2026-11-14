import assert from "node:assert";
import { describe, it } from "node:test";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";
import { visibleWidth } from "../src/utils.ts";

const theme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "> ",
	hint: (text) => text,
};

describe("SettingsList", () => {
	it("keeps the empty-state line within the render width", () => {
		const list = new SettingsList(
			[],
			5,
			theme,
			() => {},
			() => {},
		);
		assert.deepStrictEqual(list.render(40), ["  No settings available"]);
		for (const line of list.render(10)) {
			assert.ok(visibleWidth(line) <= 10, JSON.stringify(line));
		}
	});
});
