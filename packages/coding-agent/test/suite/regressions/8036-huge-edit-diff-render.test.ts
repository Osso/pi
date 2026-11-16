import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../../../src/core/tools/edit.ts";
import { generateDiffString } from "../../../src/core/tools/edit-diff.ts";
import { RenderRegionContainer } from "../../../src/modes/interactive/components/render-region-container.ts";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";

const tui = {
	requestRender: () => {},
	addInterval: () => ({ dispose: () => {} }),
	removeInterval: () => {},
	requestComponentRender: () => false,
	createRenderRegion: () => ({ place() {}, clear() {}, dispose() {}, tryRender: () => false }),
} as unknown as TUI;

describe("chat render of a huge edit diff (#8036)", () => {
	beforeAll(() => initTheme("dark"));

	it("renders an edit result that wraps to more lines than V8 accepts as call arguments", () => {
		// One multi-megabyte line, as in an edit to exported HTML, wraps to ~200k display lines at width 40.
		const longLine = "x".repeat(7_000_000);
		const { diff, firstChangedLine } = generateDiffString(`a\n${longLine}\n`, `b\n${longLine}y\n`);
		const edit = new ToolExecutionComponent(
			"edit",
			"edit-huge-diff",
			{ path: "export.html", edits: [{ oldText: "a", newText: "b" }] },
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		edit.setArgsComplete();
		edit.updateResult({
			content: [{ type: "text", text: "ok" }],
			details: { diff, firstChangedLine },
			isError: false,
		});
		const chat = new RenderRegionContainer(tui);
		chat.addChild(edit);

		const lines = chat.render(40);

		expect(lines.length).toBeGreaterThan(150_000);
		expect(lines.length).toBe(edit.render(40).length);
		// Diffing and wrapping a 7 MB line takes ~18 s on an idle machine; the default 30 s times out under full-suite load.
	}, 120_000);
});
