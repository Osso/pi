import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function getContentChildren(component: AssistantMessageComponent): Container["children"] {
	const contentContainer = component.children[0];
	expect(contentContainer).toBeInstanceOf(Container);
	return (contentContainer as Container).children;
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "stopReason">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: overrides.stopReason ?? "stop",
		timestamp: Date.now(),
	};
}

describe("AssistantMessageComponent", () => {
	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("renders length stops as visible errors", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }], { stopReason: "length" }),
			true,
		);
		const rendered = component.render(80).join("\n");

		expect(rendered).toContain("Thinking...");
		expect(rendered).toContain("maximum output token limit");
		expect(rendered).toContain("response may be incomplete");
	});

	test("uses configured output padding for text and thinking", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "reasoning" },
			]),
			false,
			undefined,
			"Thinking...",
			1,
		);
		const lines = component.render(80).map((line) => stripAnsi(line));

		expect(lines.some((line) => line.includes(" hello"))).toBe(true);
		expect(lines.some((line) => line.includes(" reasoning"))).toBe(true);

		component.setOutputPad(0);
		const updatedLines = component.render(80).map((line) => stripAnsi(line));
		expect(updatedLines.some((line) => line.startsWith("hello"))).toBe(true);
		expect(updatedLines.some((line) => line.startsWith("reasoning"))).toBe(true);
	});

	test("uses configured output padding for user messages", () => {
		initTheme("dark");

		const paddedComponent = new UserMessageComponent("hello", undefined, 1);
		const paddedLines = paddedComponent.render(40).map((line) => stripAnsi(line));
		expect(paddedLines.some((line) => line.startsWith(" hello"))).toBe(true);

		const unpaddedComponent = new UserMessageComponent("hello", undefined, 0);
		const unpaddedLines = unpaddedComponent.render(40).map((line) => stripAnsi(line));
		expect(unpaddedLines.some((line) => line.startsWith("hello"))).toBe(true);
	});

	test("retains markdown component identity while streamed text grows", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const initialChildren = getContentChildren(component);
		const markdown = initialChildren[1];

		component.updateContent(createAssistantMessage([{ type: "text", text: "hello world" }]));
		const updatedChildren = getContentChildren(component);

		expect(updatedChildren[1]).toBe(markdown);
		expect(
			component
				.render(40)
				.map((line) => stripAnsi(line).trimEnd())
				.join("\n"),
		).toContain("hello world");
	});

	test("retains thinking markdown and inserts a spacer when text follows", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "reasoning" }]),
		);
		const initialChildren = getContentChildren(component);
		const thinkingMarkdown = initialChildren[1];

		component.updateContent(
			createAssistantMessage([
				{ type: "thinking", thinking: "reasoning continues" },
				{ type: "text", text: "answer" },
			]),
		);
		const updatedChildren = getContentChildren(component);

		expect(updatedChildren[1]).toBe(thinkingMarkdown);
		expect(updatedChildren).toHaveLength(4);
		expect(
			component
				.render(60)
				.map((line) => stripAnsi(line))
				.join("\n"),
		).toContain("answer");
	});

	test("retains thinking spacer while following content streams", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "reasoning" },
				{ type: "text", text: "answer" },
			]),
		);
		const initialSpacer = getContentChildren(component)[2];

		component.updateContent(
			createAssistantMessage([
				{ type: "thinking", thinking: "reasoning continues" },
				{ type: "text", text: "answer continues" },
			]),
		);

		expect(getContentChildren(component)[2]).toBe(initialSpacer);
	});

	test("swaps hidden thinking text when visibility changes", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "reasoning" }]),
		);
		const visibleMarkdown = getContentChildren(component)[1];

		component.setHideThinkingBlock(true);
		const hiddenText = getContentChildren(component)[1];

		expect(hiddenText).not.toBe(visibleMarkdown);
		expect(
			component
				.render(60)
				.map((line) => stripAnsi(line))
				.join("\n"),
		).toContain("Thinking...");

		component.setHideThinkingBlock(false);
		expect(getContentChildren(component)[1]).not.toBe(hiddenText);
	});

	test("reconciles shrinking and content type changes", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "reasoning" },
				{ type: "text", text: "answer" },
			]),
		);

		component.updateContent(createAssistantMessage([{ type: "text", text: "replacement" }]));
		const children = getContentChildren(component);

		expect(children).toHaveLength(2);
		expect(
			component
				.render(60)
				.map((line) => stripAnsi(line))
				.join("\n"),
		).not.toContain("reasoning");
		expect(
			component
				.render(60)
				.map((line) => stripAnsi(line))
				.join("\n"),
		).toContain("replacement");
	});

	test("removes thinking spacing when following visible content disappears", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "reasoning" },
				{ type: "text", text: "answer" },
			]),
		);

		expect(component.render(60).map((line) => stripAnsi(line).trim())).toEqual(["", "reasoning", "", "answer"]);

		component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "reasoning" }]));

		expect(component.render(60).map((line) => stripAnsi(line).trim())).toEqual(["", "reasoning"]);
	});

	test("retained components render correctly after a width change", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "one two three four five six" }]),
		);
		const markdown = getContentChildren(component)[1];
		const narrowLines = component.render(20);
		const wideLines = component.render(60);

		expect(getContentChildren(component)[1]).toBe(markdown);
		expect(narrowLines.length).toBeGreaterThan(wideLines.length);
	});
});
