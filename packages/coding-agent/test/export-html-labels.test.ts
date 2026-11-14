import { describe, expect, it } from "vitest";
import { renderExportHtml } from "./fixtures/export-html-dom.ts";

function renderTreeHtml(labelEntries: Array<{ id: string; label: string | undefined }>): string {
	const timestamp = "2026-11-14T00:00:00.000Z";
	const entries: object[] = [
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp,
			message: { role: "user", content: "hello", timestamp: 0 },
		},
	];
	let parentId = "u1";
	for (const { id, label } of labelEntries) {
		entries.push({ type: "label", id, parentId, timestamp, targetId: "u1", label });
		parentId = id;
	}
	return renderExportHtml(entries, parentId);
}

describe("export HTML labels", () => {
	it("shows the current label of an entry", () => {
		expect(renderTreeHtml([{ id: "l1", label: "checkpoint" }])).toContain(
			'<span class="tree-label">[checkpoint]</span>',
		);
	});

	it("does not show a label that was cleared later", () => {
		const html = renderTreeHtml([
			{ id: "l1", label: "checkpoint" },
			{ id: "l2", label: undefined },
		]);
		expect(html).toContain("tree-role-user");
		expect(html).not.toContain("tree-label");
	});
});
