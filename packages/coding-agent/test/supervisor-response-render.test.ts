import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createSupervisorResponseTool } from "../src/supervisor/response-tool.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const tui = {
	requestRender: () => {},
	addInterval: () => ({ dispose: () => {} }),
	removeInterval: () => {},
	requestComponentRender: () => false,
} as unknown as TUI;

async function renderResponse(args: Record<string, unknown>): Promise<string> {
	const tool = createSupervisorResponseTool();
	const component = new ToolExecutionComponent(
		tool.name,
		"call-1",
		args,
		{},
		tool as unknown as ToolDefinition,
		tui,
		process.cwd(),
	);
	const result = await tool.execute("call-1", args as never, undefined, undefined, undefined as never);
	component.updateResult({ ...result, isError: false }, false);
	return stripAnsi(component.render(120).join("\n"));
}

describe("supervisor_response rendering", () => {
	beforeAll(() => initTheme("dark"));

	test("shows the decision kind and its text instead of only the tool name", async () => {
		const rendered = await renderResponse({
			kind: "continue",
			reason: "The goal still has open items.",
			instructions: "Finish the shapeTrace removal and commit it.",
		});
		expect(rendered).toContain("supervisor_response continue");
		expect(rendered).toContain("The goal still has open items.");
		expect(rendered).toContain("Finish the shapeTrace removal and commit it.");
		expect(rendered).not.toContain("Supervisor response recorded.");
	});

	test("shows advisory answers once and each question answer with its reason", async () => {
		const advisory = await renderResponse({ kind: "advisory", answer: "Delete the stale entry." });
		expect(advisory.match(/Delete the stale entry\./g)).toHaveLength(1);
		const answered = await renderResponse({
			kind: "answer",
			answers: { "Which tag?": { answer: "Compact tag", reason: "User chose it earlier." } },
		});
		expect(answered).toContain("Which tag? → Compact tag (User chose it earlier.)");
	});
});
