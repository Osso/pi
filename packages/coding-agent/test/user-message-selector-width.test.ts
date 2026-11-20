import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("user message selector width", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("keeps message position lines within a narrow terminal", () => {
		const messages = Array.from({ length: 100 }, (_, index) => ({ id: `m${index}`, text: `message ${index}` }));
		const selector = new UserMessageSelectorComponent(
			messages,
			() => {},
			() => {},
		);

		const lines = selector.render(18);

		expect(lines.filter((line) => visibleWidth(line) > 18)).toEqual([]);
	});
});
