import { Text, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test } from "vitest";
import { createPyrunToolDefinition } from "../extensions/pyrun/src/index.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { generateDiffString } from "../src/core/tools/edit-diff.ts";
import { createEndTurnToolDefinition } from "../src/core/tools/end-turn.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
		addInterval: () => ({ dispose: () => {} }),
		removeInterval: () => {},
		requestComponentRender: () => false,
	} as unknown as TUI;
}

function createWaitAgentToolDefinition(): ToolDefinition {
	return {
		name: "wait_agent",
		label: "wait_agent",
		description: "Wait for child agents",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		renderResult: (result) =>
			new Text(result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "", 0, 0),
	};
}

function createCustomToolDefinition(): ToolDefinition {
	return {
		name: "custom_tool",
		label: "custom_tool",
		description: "Custom tool",
		parameters: Type.Object({ query: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		renderCall: (args) => new Text(`custom_tool ${(args as { query?: string }).query ?? ""}`, 0, 0),
		renderResult: (result) =>
			new Text(result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "", 0, 0),
	};
}

type ToolKind = "bash" | "pyrun_eval" | "edit" | "wait_agent" | "end_turn" | "custom_tool";
type ToolState = "pending" | "success" | "error";

const SECRET_ARGS = "secret-call-arg";
const SECRET_OUTPUT = "secret-tool-output";

function buildComponent(
	toolKind: ToolKind,
	hideOutput: boolean,
	expanded: boolean,
	state: ToolState,
): ToolExecutionComponent {
	const tui = createFakeTui();
	const cwd = process.cwd();
	let args: Record<string, unknown> = { query: SECRET_ARGS };
	let definition: ToolDefinition | undefined;

	switch (toolKind) {
		case "bash":
			args = { command: SECRET_ARGS };
			definition = createBashToolDefinition(cwd);
			break;
		case "pyrun_eval":
			args = { code: `print('${SECRET_ARGS}')` };
			definition = createPyrunToolDefinition(async () => ({ content: [], details: undefined }));
			break;
		case "edit":
			args = { path: "/tmp/matrix.txt", edits: [{ oldText: "before", newText: "after" }] };
			break;
		case "wait_agent":
			args = {};
			definition = createWaitAgentToolDefinition();
			break;
		case "end_turn":
			args = { reason: "done" };
			definition = createEndTurnToolDefinition();
			break;
		case "custom_tool":
			definition = createCustomToolDefinition();
			break;
	}

	const component = new ToolExecutionComponent(
		toolKind,
		`matrix-${toolKind}-${hideOutput}-${expanded}-${state}`,
		args,
		{ hideOutput },
		definition,
		tui,
		cwd,
	);
	component.setExpanded(expanded);
	component.markExecutionStarted(1_000);
	if (state !== "pending") {
		component.updateResult(
			{
				content: [{ type: "text", text: SECRET_OUTPUT }],
				details: toolKind === "edit" && state === "success" ? generateDiffString("before\n", "after\n") : undefined,
				isError: state === "error",
			},
			false,
			2_000,
		);
	}
	return component;
}

describe("ToolExecutionComponent mode matrix", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	const cases: Array<{
		toolKind: ToolKind;
		hideOutput: boolean;
		expanded: boolean;
		state: ToolState;
	}> = [];
	for (const toolKind of ["bash", "pyrun_eval", "edit", "wait_agent", "end_turn", "custom_tool"] as const) {
		for (const hideOutput of [false, true]) {
			for (const expanded of [false, true]) {
				for (const state of ["pending", "success", "error"] as const) {
					cases.push({ toolKind, hideOutput, expanded, state });
				}
			}
		}
	}

	test.each(cases)(
		"$toolKind (hideOutput=$hideOutput, expanded=$expanded, state=$state) preserves margins, width bounds, and visibility",
		({ toolKind, hideOutput, expanded, state }) => {
			const component = buildComponent(toolKind, hideOutput, expanded, state);

			for (const width of [24, 80]) {
				const rawLines = component.render(width);
				const plainLines = rawLines.map(stripAnsi);

				expect(plainLines[0]).toBe("");
				expect(plainLines.length).toBeGreaterThanOrEqual(2);
				expect(plainLines[1]?.search(/\S/)).toBe(1);
				if (toolKind === "wait_agent" || toolKind === "end_turn" || (hideOutput && toolKind === "bash")) {
					expect(rawLines.every((line) => visibleWidth(line) <= width)).toBe(true);
				}
			}

			const rendered80 = stripAnsi(component.render(80).join("\n"));
			if (hideOutput) {
				expect(rendered80).not.toContain(SECRET_OUTPUT);
				if (toolKind === "bash" || toolKind === "pyrun_eval") {
					expect(rendered80).not.toContain(SECRET_ARGS);
				}
			} else if (state !== "pending") {
				const expectsResultVisible =
					toolKind === "wait_agent" || toolKind === "end_turn"
						? expanded || state === "error"
						: toolKind === "edit"
							? state === "error"
							: true;
				if (expectsResultVisible) {
					expect(rendered80).toContain(SECRET_OUTPUT);
				}
			}
		},
	);
});
