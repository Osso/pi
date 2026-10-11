import { readFileSync } from "node:fs";
import type { AssistantMessage, ThinkingContent } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/anthropic-narration.json", import.meta.url), "utf8")) as {
	entryId: string;
	timestamp: string;
	content: ThinkingContent[];
};
const ordinaryThinking = fixture.content[0];
const narration = fixture.content[1];

function createMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.parse(fixture.timestamp),
	};
}

function renderPlain(component: AssistantMessageComponent): string {
	return component.render(400).map(stripAnsi).join("\n");
}

const toolCall: AssistantMessage["content"][number] = {
	type: "toolCall",
	id: "following-tool",
	name: "bash",
	arguments: { command: "printf done" },
};

// Malformed length-delimited field: declares ten bytes but contains only eight.
const truncatedSignature = Buffer.from([0x12, 0x0c, 0x0a, 0x0a, 0x42, 0x0a, ...Buffer.from("narration")]).toString(
	"base64",
);

describe("signed Anthropic narration rendering", () => {
	test("renders captured production narration as normal answer while real thinking is hidden", () => {
		initTheme("dark");
		const message = createMessage([...structuredClone(fixture.content), toolCall]);
		const original = structuredClone(message);
		const component = new AssistantMessageComponent(message, true);
		const expected = new AssistantMessageComponent(
			createMessage([ordinaryThinking, { type: "text", text: narration.thinking }, toolCall]),
			true,
		);

		expect(renderPlain(component)).toContain("Agreed, with the condition that deploys only happen");
		expect(renderPlain(component)).not.toContain(ordinaryThinking.thinking.trim());
		expect(component.render(400)).toEqual(expected.render(400));
		expect(message).toEqual(original);
	});

	test.each([true, false])("signature arriving at thinking_end becomes normal prose (hide=%s)", (hide) => {
		initTheme("dark");
		const partial = createMessage([ordinaryThinking, { type: "thinking", thinking: narration.thinking }]);
		const component = new AssistantMessageComponent(partial, hide);
		const expectedPartial = new AssistantMessageComponent(structuredClone(partial), hide);
		expect(component.render(400)).toEqual(expectedPartial.render(400));
		if (hide) expect(renderPlain(component)).not.toContain(narration.thinking.trim());

		const completed = createMessage([...structuredClone(fixture.content), toolCall]);
		const original = structuredClone(completed);
		// Interactive mode forwards the completed thinking block through updateContent at thinking_end.
		component.updateContent(completed);
		const expected = new AssistantMessageComponent(
			createMessage([ordinaryThinking, { type: "text", text: narration.thinking }, toolCall]),
			hide,
		);
		expect(component.render(400)).toEqual(expected.render(400));
		expect(renderPlain(component)).toContain(narration.thinking.trim());
		expect(completed).toEqual(original);
		expect(partial.content[1]).not.toHaveProperty("thinkingSignature");
	});

	test("keeps narration visible across thinking visibility changes and invalidation", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(createMessage(structuredClone(fixture.content)), true);
		for (const hide of [false, true]) {
			component.setHideThinkingBlock(hide);
			component.invalidate();
			const expected = new AssistantMessageComponent(
				createMessage([ordinaryThinking, { type: "text", text: narration.thinking }]),
				hide,
			);
			expect(component.render(400)).toEqual(expected.render(400));
		}
	});

	test.each([
		["missing", undefined],
		["ordinary", ordinaryThinking.thinkingSignature],
		["invalid base64", "not a signature"],
		["truncated varint", "gA=="],
		["truncated field", truncatedSignature],
	])("does not expose thinking with %s signature", (_label, thinkingSignature) => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createMessage([{ type: "thinking", thinking: narration.thinking, thinkingSignature }]),
			true,
		);
		expect(renderPlain(component)).toContain("Thinking...");
		expect(renderPlain(component)).not.toContain(narration.thinking.trim());
	});

	test("preserves content order around narration and the following tool", () => {
		initTheme("dark");
		const message = createMessage([
			{ type: "text", text: "Before narration" },
			structuredClone(narration),
			toolCall,
			{ type: "text", text: "After tool" },
		]);
		const original = structuredClone(message);
		const rendered = renderPlain(new AssistantMessageComponent(message, true));
		expect(rendered.indexOf("Before narration")).toBeLessThan(rendered.indexOf(narration.thinking.trim()));
		expect(rendered.indexOf(narration.thinking.trim())).toBeLessThan(rendered.indexOf("After tool"));
		expect(message).toEqual(original);
	});
});
