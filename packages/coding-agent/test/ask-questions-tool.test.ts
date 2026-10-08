import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PERSISTENT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS } from "../src/core/desktop-notification.ts";
import { createAskQuestionsToolDefinition } from "../src/core/tools/ask-questions.ts";

const desktopNotifier = vi.hoisted(() => vi.fn());

vi.mock("../src/core/desktop-notification.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/desktop-notification.ts")>();
	return {
		...actual,
		sendDesktopNotification: desktopNotifier,
	};
});

import { type Component, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createAllToolDefinitions, DEFAULT_ACTIVE_TOOL_NAMES } from "../src/core/tools/index.ts";
import type { ExtensionContext } from "../src/index.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, type Theme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const KEY = {
	down: "\x1b[B",
	enter: "\r",
	escape: "\x1b",
	left: "\x1b[D",
	right: "\x1b[C",
	shiftTab: "\x1b[Z",
	tab: "\t",
	up: "\x1b[A",
};

/** Drives the real ask_questions panel with key input; `screens` records the panel after every key. */
function setup(keys: string[]) {
	const screens: string[] = [];
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const custom = async <T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => Component | Promise<Component>,
	): Promise<T> => {
		let result: { value: T } | undefined;
		const tui = { requestRender: () => {} } as unknown as TUI;
		const component = await factory(tui, theme, keybindings, (value) => {
			result = { value };
		});
		const capture = () => screens.push(stripAnsi(component.render(80).join("\n")));
		capture();
		for (const key of keys) {
			if (result) break;
			component.handleInput?.(key);
			capture();
		}
		if (!result) throw new Error(`Panel still open after keys: ${JSON.stringify(keys)}`);
		return result.value;
	};
	const ctx = { hasUI: true, mode: "tui", ui: { custom } } as unknown as ExtensionContext;
	return { ctx, screens };
}

describe("ask_questions tool", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		desktopNotifier.mockReset();
	});

	it("is registered as a default active built-in tool", () => {
		const tools = createAllToolDefinitions(process.cwd());

		expect(DEFAULT_ACTIVE_TOOL_NAMES).toContain("ask_questions");
		expect(tools.ask_questions.name).toBe("ask_questions");
		expect(tools.ask_questions.promptGuidelines?.join("\n")).toContain("interactive TUI sessions");
	});

	it("exposes min/max schema constraints", () => {
		const tool = createAskQuestionsToolDefinition();
		const schema = tool.parameters as {
			properties: {
				questions: { minItems?: number; maxItems?: number; items?: { properties?: { options?: unknown } } };
			};
		};
		const questionItems = schema.properties.questions.items as {
			properties: { options: { minItems?: number; maxItems?: number } };
		};

		expect(schema.properties.questions.minItems).toBe(1);
		expect(schema.properties.questions.maxItems).toBe(4);
		expect(questionItems.properties.options.minItems).toBe(2);
		expect(questionItems.properties.options.maxItems).toBe(4);
	});

	it("asks a single-choice question and returns the selected label", async () => {
		const tool = createAskQuestionsToolDefinition();
		const { ctx } = setup([KEY.enter]);

		const result = await tool.execute(
			"call-1",
			{
				questions: [
					{
						question: "Which approach should we use?",
						header: "Approach",
						options: [
							{ label: "Direct API", description: "Keep code simple" },
							{ label: "Adapter", description: "Add indirection" },
						],
					},
				],
			},
			undefined,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			cancelled: false,
			answers: { "Which approach should we use?": "Direct API" },
		});
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Direct API") });
	});

	it("adds an automatic Other option for custom answers", async () => {
		const tool = createAskQuestionsToolDefinition();
		const { ctx } = setup([KEY.down, KEY.down, KEY.enter, "Use a plugin", KEY.enter]);

		const result = await tool.execute(
			"call-2",
			{
				questions: [
					{
						question: "What should we build?",
						options: [{ label: "Tool" }, { label: "Extension" }],
					},
				],
			},
			undefined,
			undefined,
			ctx,
		);

		expect(result.details?.answers).toEqual({ "What should we build?": "Use a plugin" });
	});

	it("supports multi-select questions", async () => {
		const tool = createAskQuestionsToolDefinition();
		const { ctx } = setup([KEY.enter, KEY.down, KEY.enter, KEY.right, KEY.enter]);

		const result = await tool.execute(
			"call-3",
			{
				questions: [
					{
						question: "Which follow-ups should be included?",
						multiSelect: true,
						options: [{ label: "Tests" }, { label: "Docs" }],
					},
				],
			},
			undefined,
			undefined,
			ctx,
		);

		expect(result.details?.answers).toEqual({ "Which follow-ups should be included?": "Tests, Docs" });
	});

	it("sends a persistent desktop notification while waiting for answers", async () => {
		const close = vi.fn();
		desktopNotifier.mockReturnValue({ close });
		const tool = createAskQuestionsToolDefinition();
		const { ctx } = setup([KEY.enter]);

		const result = await tool.execute(
			"call-notify",
			{ questions: [{ question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] }] },
			undefined,
			undefined,
			ctx,
		);

		expect(result.details?.cancelled).toBe(false);
		expect(desktopNotifier).toHaveBeenCalledWith({
			body: "Pi is waiting for your answer.",
			expireTimeMs: PERSISTENT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS,
			title: "Pi question needs input",
			urgency: "normal",
		});
		expect(close).toHaveBeenCalledOnce();
	});

	it("closes the desktop notification when questions are cancelled", async () => {
		const close = vi.fn();
		desktopNotifier.mockReturnValue({ close });
		const tool = createAskQuestionsToolDefinition();
		const { ctx } = setup([KEY.escape]);

		const result = await tool.execute(
			"call-notify-cancel",
			{ questions: [{ question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] }] },
			undefined,
			undefined,
			ctx,
		);

		expect(result.details?.cancelled).toBe(true);
		expect(desktopNotifier).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
	});

	it("does not expose question or option text in the desktop notification", async () => {
		desktopNotifier.mockReturnValue(undefined);
		const tool = createAskQuestionsToolDefinition();
		const { ctx } = setup([KEY.enter]);

		await tool.execute(
			"call-notify-redacted",
			{
				questions: [
					{
						question: "Should we use token secret-question-token?",
						options: [{ label: "Ship secret option" }, { label: "Hide secret option" }],
					},
				],
			},
			undefined,
			undefined,
			ctx,
		);

		const notification = desktopNotifier.mock.calls[0]?.[0];
		expect(notification?.body).not.toContain("secret-question-token");
		expect(notification?.body).not.toContain("secret option");
	});

	it("rejects duplicate option labels", async () => {
		const tool = createAskQuestionsToolDefinition();
		const { ctx } = setup([]);

		await expect(
			tool.execute(
				"call-duplicate-options",
				{
					questions: [
						{
							question: "Pick one?",
							options: [{ label: "A" }, { label: "A" }],
						},
					],
				},
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow('Duplicate option label "A" in question "Pick one?"');
	});

	it("returns partial answers when cancelled after earlier questions", async () => {
		const tool = createAskQuestionsToolDefinition();
		const { ctx } = setup([KEY.enter, KEY.escape]);

		const result = await tool.execute(
			"call-cancel-partial",
			{
				questions: [
					{ question: "First?", options: [{ label: "First" }, { label: "Second" }] },
					{ question: "Second?", options: [{ label: "Third" }, { label: "Fourth" }] },
				],
			},
			undefined,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			cancelled: true,
			answers: { "First?": "First" },
		});
	});

	const twoQuestions = {
		questions: [
			{ question: "First?", header: "One", options: [{ label: "First" }, { label: "Second" }] },
			{ question: "Second?", header: "Two", options: [{ label: "Third" }, { label: "Fourth" }] },
		],
	};

	it("goes back to an answered question and revises it before submitting", async () => {
		const tool = createAskQuestionsToolDefinition();
		const { ctx, screens } = setup([
			KEY.enter,
			KEY.enter,
			KEY.left,
			KEY.left,
			KEY.down,
			KEY.enter,
			KEY.right,
			KEY.enter,
		]);

		const result = await tool.execute("call-revise", twoQuestions, undefined, undefined, ctx);

		expect(result.details).toMatchObject({ cancelled: false, answers: { "First?": "Second", "Second?": "Third" } });
		const backOnFirst = screens[4];
		expect(backOnFirst).toContain("First?");
		expect(backOnFirst).toContain("● 1. First");
		expect(backOnFirst).toContain("■ One");
		expect(backOnFirst).toContain("■ Two");
	});

	it("moves between questions with tab and shift+tab without answering", async () => {
		const tool = createAskQuestionsToolDefinition();
		const { ctx, screens } = setup([KEY.tab, KEY.enter, KEY.shiftTab, KEY.shiftTab, KEY.enter, KEY.right, KEY.enter]);

		const result = await tool.execute("call-tabs", twoQuestions, undefined, undefined, ctx);

		expect(screens[1]).toContain("Second?");
		expect(result.details).toMatchObject({ cancelled: false, answers: { "First?": "First", "Second?": "Third" } });
	});

	it("keeps the Submit tab closed until every single-choice question is answered", async () => {
		const tool = createAskQuestionsToolDefinition();
		const { ctx, screens } = setup([KEY.right, KEY.right, KEY.enter, KEY.escape]);

		const result = await tool.execute("call-unanswered", twoQuestions, undefined, undefined, ctx);

		expect(screens[3]).toContain("Answer every question to submit");
		expect(result.details).toMatchObject({ cancelled: true, answers: {} });
	});

	it("keeps an Other answer when navigating away and back", async () => {
		const tool = createAskQuestionsToolDefinition();
		const { ctx, screens } = setup([
			KEY.down,
			KEY.down,
			KEY.enter,
			"Mixed",
			KEY.enter,
			KEY.left,
			KEY.right,
			KEY.enter,
			KEY.enter,
		]);

		const result = await tool.execute("call-other-revisit", twoQuestions, undefined, undefined, ctx);

		expect(screens[6]).toContain("✎ Other: Mixed");
		expect(result.details).toMatchObject({ cancelled: false, answers: { "First?": "Mixed", "Second?": "Third" } });
	});

	it("rejects duplicate questions", async () => {
		const tool = createAskQuestionsToolDefinition();
		const { ctx } = setup([]);

		await expect(
			tool.execute(
				"call-4",
				{
					questions: [
						{ question: "Duplicate?", options: [{ label: "A" }, { label: "B" }] },
						{ question: "Duplicate?", options: [{ label: "C" }, { label: "D" }] },
					],
				},
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("Duplicate question text: Duplicate?");
	});

	it("returns an error outside interactive TUI mode", async () => {
		const tool = createAskQuestionsToolDefinition();
		const ctx = { hasUI: false, mode: "print" } as unknown as ExtensionContext;

		const result = await tool.execute(
			"call-5",
			{ questions: [{ question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] }] },
			undefined,
			undefined,
			ctx,
		);

		expect(result.isError).toBe(true);
		expect(result.details?.cancelled).toBe(true);
	});

	it("shows questions and answers in the transcript row while tool output is hidden", async () => {
		const tool = createAskQuestionsToolDefinition();
		const args = {
			questions: [
				{ question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] },
				{ question: "Which cache?", options: [{ label: "Redis" }, { label: "None" }] },
			],
		};
		const ui = { requestRender: () => {} } as unknown as TUI;
		const component = new ToolExecutionComponent(
			"ask_questions",
			"call-6",
			args,
			{ hideOutput: true },
			tool,
			ui,
			process.cwd(),
		);

		const pending = stripAnsi(component.render(120).join("\n"));
		expect(pending).toContain("ask_questions 2 questions");
		expect(pending).toContain("Which database?");
		expect(pending).not.toContain("→");

		const result = await tool.execute("call-6", args, undefined, undefined, setup([KEY.enter, KEY.escape]).ctx);
		component.updateResult({ ...result, isError: false }, false);

		const lines = stripAnsi(component.render(120).join("\n"))
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		expect(lines.slice(0, 3)).toEqual([
			"ask_questions 2 questions",
			"Which database? → Postgres",
			"Which cache? → (cancelled)",
		]);
	});
});
