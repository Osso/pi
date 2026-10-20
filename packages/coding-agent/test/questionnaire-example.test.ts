import { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import questionnaire from "../examples/extensions/questionnaire.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/index.ts";

interface CustomComponent {
	render(width: number): string[];
	handleInput(data: string): void;
}

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function registerQuestionnaire(): ToolDefinition {
	let tool: ToolDefinition | undefined;
	questionnaire({
		registerTool: (definition: ToolDefinition) => {
			tool = definition;
		},
	} as unknown as ExtensionAPI);
	return tool!;
}

function runWithKeys(params: unknown, keys: string[]) {
	const tool = registerQuestionnaire();
	const renders: string[][] = [];
	const ctx = {
		mode: "tui",
		ui: {
			custom: (factory: (...args: unknown[]) => CustomComponent) =>
				new Promise((resolve) => {
					const component = factory(new TUI(new VirtualTerminal()), theme, undefined, resolve);
					for (const key of keys) {
						component.handleInput(key);
						renders.push(component.render(40));
					}
				}),
		},
	} as unknown as ExtensionContext;
	const result = tool.execute("call-1", params as never, undefined, undefined, ctx);
	return { result, renders };
}

describe("questionnaire example", () => {
	it("ignores Down and Enter when a question has no selectable options", async () => {
		const params = { questions: [{ id: "scope", prompt: "Pick one", options: [], allowOther: false }] };
		const { result, renders } = runWithKeys(params, ["\x1b[B", "\r", "\x1b"]);

		await expect(result).resolves.toMatchObject({
			content: [{ type: "text", text: "User cancelled the questionnaire" }],
			details: { answers: [], cancelled: true },
		});
		expect(renders[0]).toEqual(renders[1]);
	});

	it("still selects options after the empty-question guard", async () => {
		const params = {
			questions: [{ id: "size", prompt: "Size?", options: [{ value: "s", label: "Small" }], allowOther: false }],
		};
		const { result } = runWithKeys(params, ["\x1b[B", "\r"]);

		await expect(result).resolves.toMatchObject({
			content: [{ type: "text", text: "Q1: user selected: 1. Small" }],
		});
	});
});
