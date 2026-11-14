import { describe, expect, it } from "vitest";
import { renderExportHtml } from "./fixtures/export-html-dom.ts";

const timestamp = "2026-11-14T00:00:00.000Z";
const message = (id: string, parentId: string | null, body: object) => ({
	type: "message",
	id,
	parentId,
	timestamp,
	message: { timestamp: 0, ...body },
});

describe("export HTML conversation path", () => {
	it("does not show a tool result from an abandoned branch", () => {
		const html = renderExportHtml(
			[
				message("u1", null, { role: "user", content: "run the tool" }),
				message("a1", "u1", {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
					api: "faux",
					provider: "faux",
					model: "faux",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
					stopReason: "toolUse",
				}),
				message("t1", "a1", {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [{ type: "text", text: "ABANDONED-RESULT" }],
					isError: false,
				}),
				message("u2", "a1", { role: "user", content: "ALTERNATE-BRANCH" }),
			],
			"u2",
		);

		expect(html).toContain("ALTERNATE-BRANCH");
		expect(html).not.toContain("ABANDONED-RESULT");
	});

	it("shows the text of a custom message with content blocks", () => {
		const html = renderExportHtml(
			[
				{
					type: "custom_message",
					id: "c1",
					parentId: null,
					timestamp,
					customType: "notice",
					content: [{ type: "text", text: "NOTICE-TEXT" }],
					display: true,
				},
			],
			"c1",
		);

		expect(html).toContain("NOTICE-TEXT");
		expect(html).not.toContain('"type":"text"');
	});
});
