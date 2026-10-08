import { beforeEach, describe, expect, it, vi } from "vitest";
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

import type { TUI } from "@earendil-works/pi-tui";
import { createAllToolDefinitions, DEFAULT_ACTIVE_TOOL_NAMES } from "../src/core/tools/index.ts";
import type { ExtensionContext } from "../src/index.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function setup(options: { selectChoices: Array<string | undefined>; inputChoices?: Array<string | undefined> }) {
	const selectChoices = [...options.selectChoices];
	const inputChoices = [...(options.inputChoices ?? [])];
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			select: vi.fn(async () => selectChoices.shift()),
			input: vi.fn(async () => inputChoices.shift()),
		},
	} as unknown as ExtensionContext;
	return ctx;
}

describe("ask_questions tool", () => {
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
		const ctx = setup({ selectChoices: ["1. Direct API — Keep code simple"] });

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
		const ctx = setup({ selectChoices: ["Other"], inputChoices: ["Use a plugin"] });

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
		const ctx = setup({
			selectChoices: ["[ ] 1. Tests", "[ ] 2. Docs", "Done"],
		});

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
		const ctx = setup({ selectChoices: ["1. Yes"] });

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
		const ctx = setup({ selectChoices: ["Cancel"] });

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
		const ctx = setup({ selectChoices: ["1. Ship secret option"] });

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
		const ctx = setup({ selectChoices: [] });

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
		const ctx = setup({ selectChoices: ["1. First", "Cancel"] });

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

	it("rejects duplicate questions", async () => {
		const tool = createAskQuestionsToolDefinition();
		const ctx = setup({ selectChoices: [] });

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
		initTheme("dark");
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

		const result = await tool.execute(
			"call-6",
			args,
			undefined,
			undefined,
			setup({ selectChoices: ["1. Postgres", "Cancel"] }),
		);
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
