import { beforeAll, describe, expect, test } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import {
	createAssistantMessage,
	createFakeInteractiveModeThis,
	handleEvent,
} from "./fixtures/interactive-mode-streaming.ts";

function renderedLines(fakeThis: ReturnType<typeof createFakeInteractiveModeThis>): string[] {
	return fakeThis.chatContainer.render(80).map((line) => stripAnsi(line));
}

describe("interactive output padding", () => {
	beforeAll(() => initTheme("dark"));

	test.each([0, 1])("renders assistant output and errors with outputPad %i", async (outputPad) => {
		const fakeThis = Object.assign(createFakeInteractiveModeThis(), { outputPad });
		const assistant = createAssistantMessage("assistant reply");

		await handleEvent.call(fakeThis, { type: "message_start", message: assistant });
		await handleEvent.call(fakeThis, { type: "message_end", message: assistant });
		InteractiveMode.prototype.showError.call(fakeThis, "boom");

		const lines = renderedLines(fakeThis);
		const indent = " ".repeat(outputPad);
		expect(lines).toContain(`${indent}assistant reply`.padEnd(80));
		expect(lines).toContain(`${indent}Error: boom`.padEnd(80));
	});
});
