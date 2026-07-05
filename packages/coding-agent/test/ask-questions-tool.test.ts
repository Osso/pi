import { describe, expect, it, vi } from "vitest";
import { createAskQuestionsToolDefinition } from "../src/core/tools/ask-questions.ts";
import { createAllToolDefinitions, DEFAULT_ACTIVE_TOOL_NAMES } from "../src/core/tools/index.ts";
import type { ExtensionContext } from "../src/index.ts";

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
});
