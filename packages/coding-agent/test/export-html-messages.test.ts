import { describe, expect, it } from "vitest";
import { renderExportHtml } from "./fixtures/export-html-dom.ts";

const timestamp = "2026-11-14T00:00:00.000Z";

function renderBashExecution(exitCode: number | undefined): string {
	return renderExportHtml(
		[
			{
				type: "message",
				id: "b1",
				parentId: null,
				timestamp,
				message: {
					role: "bashExecution",
					command: "sleep 9",
					output: "partial",
					cancelled: false,
					exitCode,
					timestamp: 0,
				},
			},
		],
		"b1",
	);
}

describe("export HTML messages", () => {
	it("does not show a ! command without an exit code as failed", () => {
		const html = renderBashExecution(undefined);

		expect(html).toContain('<div class="tool-execution success"');
		expect(html).not.toContain("(exit");
	});

	it("shows a nonzero exit code as failed", () => {
		const html = renderBashExecution(2);

		expect(html).toContain('<div class="tool-execution error"');
		expect(html).toContain("(exit 2)");
	});

	it("keeps the text blocks of a custom message on separate lines", () => {
		const html = renderExportHtml(
			[
				{
					type: "custom_message",
					id: "c1",
					parentId: null,
					timestamp,
					customType: "notice",
					content: [
						{ type: "text", text: "FIRST" },
						{ type: "text", text: "SECOND" },
					],
					display: true,
				},
			],
			"c1",
		);

		expect(html).toContain('<div class="markdown-content">FIRST\nSECOND</div>');
	});
});
