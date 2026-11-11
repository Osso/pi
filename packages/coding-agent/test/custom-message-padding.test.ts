import { beforeAll, describe, expect, test } from "vitest";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("CustomMessageComponent default card", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("keeps only its outer margin: label is followed directly by content", () => {
		const component = new CustomMessageComponent({
			role: "custom",
			customType: "lt-watch",
			content: "Shared tracker update (lt-watch):\nlt-2c3b: comment #25 by aso-coordinator",
			display: true,
			timestamp: 0,
		} as never);

		const lines = component.render(80).map((line) => stripAnsi(line).trim());
		expect(lines).toEqual([
			"",
			"[lt-watch]",
			"Shared tracker update (lt-watch):",
			"lt-2c3b: comment #25 by aso-coordinator",
		]);
	});
});
