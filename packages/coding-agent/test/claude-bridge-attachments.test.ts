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
			{ type: "assistant", uuid: "r0", message: { id: "m0", content: [{ type: "tool_use", id: "call-1" }] } },
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
			{ type: "assistant", uuid: "r1", message: { id: "m1", content: [{ type: "text", text: "Done" }] } },
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

	// Each case pairs CC's records with the converted pi history a rebuild imports;
	// every @file attachment must land after its own prompt.
	const file = (filename: string) => ({ type: "file", filename, content: filename });
	const reply = (id: string) => ({
		type: "assistant",
		uuid: id,
		message: { id, content: [{ type: "text", text: "ok" }] },
	});
	const carryAcrossRebuild = (records: unknown[], messages: { role: string; content: unknown }[]) =>
		placeCarriedAttachments(collectCarriedAttachments(records as JsonlRecord[]), messages);

	it("keeps attachments of a turn the bridge sent as one joined prompt", () => {
		const placed = carryAcrossRebuild(
			[
				{ type: "user", uuid: "u0", message: { role: "user", content: "Read @a.ts\nthen summarize" } },
				{ type: "attachment", uuid: "a0", parentUuid: "u0", attachment: file("a.ts") },
				reply("r0"),
				{ type: "user", uuid: "u1", message: { role: "user", content: "Now @b.ts" } },
				{ type: "attachment", uuid: "a1", parentUuid: "u1", attachment: file("b.ts") },
			],
			[
				{ role: "user", content: "Read @a.ts" },
				{ role: "user", content: "then summarize" },
				{ role: "assistant", content: "ok" },
				{ role: "user", content: "Now @b.ts" },
			],
		);
		expect(placed).toEqual({
			attachments: [
				{ afterIndex: 1, attachment: file("a.ts") },
				{ afterIndex: 3, attachment: file("b.ts") },
			],
			skipped: [],
		});
	});

	it("counts a steer CC queued mid-turn as the prompt pi records", () => {
		const placed = carryAcrossRebuild(
			[
				{ type: "user", uuid: "u0", message: { role: "user", content: "Go" } },
				{ type: "assistant", uuid: "r0", message: { id: "r0", content: [{ type: "tool_use", id: "call-1" }] } },
				{
					type: "user",
					uuid: "t0",
					message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1" }] },
				},
				{
					type: "attachment",
					uuid: "q0",
					parentUuid: "t0",
					attachment: { type: "queued_command", prompt: "Also @c.ts" },
				},
				{ type: "attachment", uuid: "a0", parentUuid: "q0", attachment: file("c.ts") },
				reply("r1"),
				{ type: "user", uuid: "u1", message: { role: "user", content: "Then @d.ts" } },
				{ type: "attachment", uuid: "a1", parentUuid: "u1", attachment: file("d.ts") },
			],
			[
				{ role: "user", content: "Go" },
				{ role: "assistant", content: [{ type: "tool_use", id: "call-1" }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }] },
				{ role: "user", content: "Also @c.ts" },
				{ role: "assistant", content: "ok" },
				{ role: "user", content: "Then @d.ts" },
			],
		);
		expect(placed).toEqual({
			attachments: [
				{ afterIndex: 3, attachment: file("c.ts") },
				{ afterIndex: 5, attachment: file("d.ts") },
			],
			skipped: [],
		});
	});

	it("counts a prompt that repair merged with the synthetic result of an aborted call", () => {
		const placed = carryAcrossRebuild(
			[
				{ type: "user", uuid: "u0", message: { role: "user", content: "Go" } },
				{ type: "assistant", uuid: "r0", message: { id: "r0", content: [{ type: "tool_use", id: "call-1" }] } },
				// importMessages split the repaired message into a result record and a prompt record.
				{
					type: "user",
					uuid: "t0",
					message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1" }] },
				},
				{ type: "user", uuid: "u1", message: { role: "user", content: "Next @e.ts" } },
				{ type: "attachment", uuid: "a0", parentUuid: "u1", attachment: file("e.ts") },
			],
			[
				{ role: "user", content: "Go" },
				{ role: "assistant", content: [{ type: "tool_use", id: "call-1" }] },
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "call-1", content: "[no tool result recorded]" },
						{ type: "text", text: "Next @e.ts" },
					],
				},
			],
		);
		expect(placed).toEqual({ attachments: [{ afterIndex: 2, attachment: file("e.ts") }], skipped: [] });
	});
});
