import { describe, expect, it } from "vitest";
import { renderExportHtml } from "./fixtures/export-html-dom.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN3sAAAAASUVORK5CYII=";

function renderToolResultHtml(toolName: string): string {
	const timestamp = "2026-11-14T00:00:00.000Z";
	const message = (id: string, parentId: string | null, body: object) => ({
		type: "message",
		id,
		parentId,
		timestamp,
		message: { timestamp: 0, ...body },
	});
	return renderExportHtml(
		[
			message("u1", null, { role: "user", content: "take a screenshot" }),
			message("a1", "u1", {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: toolName, arguments: {} }],
				api: "faux",
				provider: "faux",
				model: "faux",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
				stopReason: "toolUse",
			}),
			message("t1", "a1", {
				role: "toolResult",
				toolCallId: "call-1",
				toolName,
				content: [{ type: "image", mimeType: "image/png", data: PNG }],
				isError: false,
			}),
		],
		"t1",
	);
}

describe("export HTML tool result images", () => {
	it("shows images returned by a custom tool", () => {
		expect(renderToolResultHtml("screenshot")).toContain(
			`<img src="data:image/png;base64,${PNG}" class="tool-image" />`,
		);
	});
});
