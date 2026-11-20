import assert from "node:assert";
import { describe, it } from "node:test";
import { type SettingItem, SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
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

	const items = (): SettingItem[] =>
		Array.from({ length: 12 }, (_, index) => ({
			id: `item-${index + 1}`,
			label: `Item ${index + 1}`,
			currentValue: "on",
		}));
	const selectedLabel = (list: SettingsList): string | undefined =>
		list
			.render(40)
			.map((line) => /^> (Item \d+)/.exec(line)?.[1])
			.find(Boolean);

	it("pages through a searchable list without resetting the selection", () => {
		const list = new SettingsList(
			items(),
			5,
			theme,
			() => {},
			() => {},
			{ enableSearch: true },
		);

		list.handleInput("\x1b[6~");
		assert.equal(selectedLabel(list), "Item 6");
		list.handleInput("\x1b[6~");
		list.handleInput("\x1b[6~");
		assert.equal(selectedLabel(list), "Item 12");
		list.handleInput("\x1b[5~");
		assert.equal(selectedLabel(list), "Item 7");
	});

	it("keeps the selected setting when moving the search caret", () => {
		const changes: string[] = [];
		const list = new SettingsList(
			[
				{ id: "hide-thinking", label: "Hide thinking", currentValue: "false", values: ["false", "true"] },
				{ id: "hide-tool-output", label: "Hide tool output", currentValue: "false", values: ["false", "true"] },
			],
			5,
			theme,
			(id, value) => changes.push(`${id}=${value}`),
			() => {},
			{ enableSearch: true },
		);
		list.handleInput("hide");
		list.handleInput("\x1b[B");
		assert.ok(list.render(60).some((line) => line.startsWith("> Hide tool output")));
		list.handleInput("\x1b[D");
		list.handleInput("\r");
		assert.deepStrictEqual(changes, ["hide-tool-output=true"]);
	});

	it("cancels instead of changing the value when Space is bound to cancel", () => {
		const previous = getKeybindings();
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": "space" }));
		try {
			const changes: string[] = [];
			let cancelled = false;
			const list = new SettingsList(
				[{ id: "autocompact", label: "Auto-compact", currentValue: "true", values: ["true", "false"] }],
				5,
				theme,
				(id, value) => changes.push(`${id}=${value}`),
				() => {
					cancelled = true;
				},
				{ enableSearch: true },
			);

			list.handleInput(" ");

			assert.equal(cancelled, true);
			assert.deepStrictEqual(changes, []);
		} finally {
			setKeybindings(previous);
		}
	});

	it("aligns values when a label is wider than the label column", () => {
		const list = new SettingsList(
			[
				{ id: "short", label: "Short", currentValue: "enabled" },
				{ id: "wide", label: "界".repeat(17), currentValue: "disabled" },
			],
			5,
			theme,
			() => {},
			() => {},
		);
		const [first, second] = list.render(80);
		const column = (line: string | undefined, text: string) =>
			visibleWidth((line ?? "").slice(0, (line ?? "").indexOf(text)));

		assert.equal(column(second, "disabled"), column(first, "enabled"));
	});
});
