import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ConfigSelectorComponent } from "../src/modes/interactive/components/config-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("config selector search cursor", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("keeps the highlighted resource when a cursor key leaves the query unchanged", () => {
		const skill = (name: string) => ({
			path: `/agent/skills/${name}/SKILL.md`,
			enabled: true,
			metadata: { source: "auto", scope: "user" as const, origin: "top-level" as const },
		});
		const selector = new ConfigSelectorComponent(
			{ extensions: [], skills: [skill("alpha-one"), skill("alpha-two")], prompts: [], themes: [] },
			SettingsManager.inMemory(),
			"/project",
			"/agent",
			() => {},
			() => {},
			() => {},
		);
		const list = selector.getResourceList();
		for (const char of "alpha") list.handleInput(char);
		list.handleInput("\x1b[B");
		const highlighted = () =>
			stripAnsi(selector.render(80).join("\n"))
				.split("\n")
				.find((line) => line.startsWith(">") && line.includes("[x]"));
		expect(highlighted()).toContain("alpha-two");

		list.handleInput("\x1b[D");

		expect(highlighted()).toContain("alpha-two");
	});
});
