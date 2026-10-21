import { describe, expect, it } from "vitest";
import overlayQaTests from "../examples/extensions/overlay-qa-tests.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/index.ts";

interface CustomComponent {
	render(width: number): string[];
}

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function registerCommands(): Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">> {
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	overlayQaTests({
		registerCommand: (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			commands.set(name, options);
		},
	} as unknown as ExtensionAPI);
	return commands;
}

describe("overlay-qa-tests example", () => {
	it("renders stacked overlays at widths too narrow for their fill rows", async () => {
		const frames: string[][] = [];
		const ctx = {
			ui: {
				notify: () => {},
				custom: (factory: (...args: unknown[]) => CustomComponent) =>
					new Promise((resolve) => {
						const component = factory(undefined, theme, undefined, resolve);
						frames.push(component.render(3));
						resolve(`closed-${frames.length}`);
					}),
			},
		} as unknown as ExtensionCommandContext;

		await registerCommands().get("overlay-stack")!.handler("", ctx);

		const truncated = "│\x1b[0m.\x1b[0m│";
		const empty = "│ │";
		const frame = ["╭─╮", truncated, truncated, empty, ...Array(5).fill(truncated), empty, truncated, "╰─╯"];
		expect(frames).toEqual([frame, frame, frame]);
	});
});
