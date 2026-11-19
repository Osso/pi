import type { KeyId } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { ExtensionShortcut } from "../src/core/extensions/types.ts";
import { formatHotkeysMarkdown } from "../src/modes/interactive/hotkeys-help.ts";

describe("formatHotkeysMarkdown", () => {
	it("lists built-in keys and omits the extensions table without extension shortcuts", () => {
		const markdown = formatHotkeysMarkdown(new Map());
		expect(markdown).toContain("**Navigation**");
		expect(markdown).toContain("| `!!` | Run bash command (excluded from context) |");
		expect(markdown).not.toContain("**Extensions**");
	});

	it("lists extension shortcuts with their description, falling back to the extension path", () => {
		const shortcuts = new Map<KeyId, ExtensionShortcut>([
			[
				"ctrl+shift+p" as KeyId,
				{ description: "Open preview", extensionPath: "/ext/preview.ts" } as ExtensionShortcut,
			],
			["alt+x" as KeyId, { extensionPath: "/ext/tools.ts" } as ExtensionShortcut],
		]);
		const markdown = formatHotkeysMarkdown(shortcuts);
		const extensions = markdown.slice(markdown.indexOf("**Extensions**"));
		expect(extensions).toContain("| Open preview |");
		expect(extensions).toContain("| /ext/tools.ts |");
		expect(markdown.endsWith("| /ext/tools.ts |")).toBe(true);
	});
});
