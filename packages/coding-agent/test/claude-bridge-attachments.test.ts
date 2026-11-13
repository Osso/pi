import type { JsonlRecord } from "cc-session-io";
import { describe, expect, it } from "vitest";
import { collectCarriedAttachments, placeCarriedAttachments } from "../extensions/claude-bridge/src/attachments.ts";

describe("Claude bridge carried attachments", () => {
	it("collects file attachments chained through ignored attachments and skips unmapped parents", () => {
		const records = [
			{
				type: "user",
				uuid: "u0",
				message: { role: "user", content: "First prompt" },
			},
			{
				type: "attachment",
				uuid: "a0",
				parentUuid: "u0",
				attachment: { type: "skill_listing", skills: [] },
			},
			{
				type: "attachment",
				uuid: "a1",
				parentUuid: "a0",
				attachment: { type: "file", filename: "foo.ts", content: "export const x = 1;" },
			},
			{
				type: "user",
				uuid: "u-tool",
				message: {
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }],
				},
			},
			{
				type: "attachment",
				uuid: "a-tool",
				parentUuid: "u-tool",
				attachment: { type: "file", filename: "ignored-tool-parent.ts", content: "nope" },
			},
			{
				type: "attachment",
				uuid: "a-orphan",
				parentUuid: null,
				attachment: { type: "file", filename: "orphan.ts", content: "nope" },
			},
			{
				type: "user",
				uuid: "u1",
				message: { role: "user", content: "Second prompt" },
			},
			{
				type: "attachment",
				uuid: "a2",
				parentUuid: "u1",
				attachment: { type: "edited_text_file", filename: "bar.ts" },
			},
			{
				type: "attachment",
				uuid: "a3",
				parentUuid: "a2",
				attachment: { type: "file", filename: "bar.ts", content: "export const y = 2;" },
			},
		] as unknown as JsonlRecord[];

		const carried = collectCarriedAttachments(records);
		expect(carried).toEqual([
			{
				attachment: { type: "file", filename: "foo.ts", content: "export const x = 1;" },
				userOrdinal: 0,
				parentText: "First prompt",
			},
			{
				attachment: { type: "file", filename: "bar.ts", content: "export const y = 2;" },
				userOrdinal: 1,
				parentText: "Second prompt",
			},
		]);
	});

	it("places matching attachments by user ordinal and skips changed or missing prompts", () => {
		const carried = [
			{
				attachment: { type: "file", filename: "foo.ts" },
				userOrdinal: 0,
				parentText: "First prompt",
			},
			{
				attachment: { type: "file", filename: "changed.ts" },
				userOrdinal: 1,
				parentText: "Old second prompt",
			},
			{
				attachment: { type: "file", filename: "missing.ts" },
				userOrdinal: 2,
				parentText: "Third prompt",
			},
		];

		const placed = placeCarriedAttachments(carried, [
			{ role: "user", content: "First prompt" },
			{ role: "assistant", content: "Reply" },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }] },
			{ role: "user", content: "Rewritten second prompt" },
		]);

		expect(placed.attachments).toEqual([{ afterIndex: 0, attachment: { type: "file", filename: "foo.ts" } }]);
		expect(placed.skipped).toEqual([
			"changed.ts: prompt #1 changed",
			"missing.ts: prompt #2 is no longer in history",
		]);
	});
});
