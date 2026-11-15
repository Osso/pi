import type { JsonlRecord } from "cc-session-io";
import { describe, expect, it } from "vitest";
import { nativePrefix } from "../extensions/claude-bridge/src/native-prefix.ts";

describe("Claude bridge native session prefix", () => {
	it("reuses a turn the bridge sent as one prompt joined from several pi messages", () => {
		// The bridge sends a trailing run of pi user messages (a steer, an extension's
		// message) as one "\n"-joined prompt; pi's history keeps them separate.
		const records = [
			{ type: "user", uuid: "u0", message: { role: "user", content: "Fix the build\nand run the tests" } },
			{
				type: "assistant",
				uuid: "r0",
				message: { id: "msg_0", model: "claude-opus-5-5", content: [{ type: "text", text: "Done." }] },
			},
		] as unknown as JsonlRecord[];
		const messages = [
			{ role: "user" as const, content: "Fix the build" },
			{ role: "user" as const, content: "and run the tests" },
			{ role: "assistant" as const, content: [{ type: "text" as const, text: "Done." }] },
			{ role: "user" as const, content: "Next task" },
		];

		const prefix = nativePrefix(records, messages);

		expect(prefix.covered).toBe(3);
		expect(prefix.records).toEqual(records);
	});

	it("reuses a turn in which Claude Code ran its own WebSearch", () => {
		// CC runs WebSearch itself: pi never sees the call or its result, and the
		// bridge streams the text before and after it into one pi assistant message.
		const assistant = (uuid: string, id: string, content: unknown[]) => ({
			type: "assistant",
			uuid,
			message: { id, model: "claude-opus-5-5", content },
		});
		const records = [
			{ type: "user", uuid: "u0", message: { role: "user", content: "What changed in Node 26?" } },
			assistant("r0", "msg_0", [
				{ type: "text", text: "Searching." },
				{ type: "tool_use", id: "srv_1", name: "WebSearch", input: { query: "Node 26" } },
			]),
			{
				type: "user",
				uuid: "t0",
				message: { role: "user", content: [{ type: "tool_result", tool_use_id: "srv_1", content: "results" }] },
			},
			assistant("r1", "msg_1", [{ type: "text", text: "Node 26 adds X." }]),
			{ type: "user", uuid: "u1", message: { role: "user", content: "Thanks" } },
		] as unknown as JsonlRecord[];
		const messages = [
			{ role: "user" as const, content: "What changed in Node 26?" },
			{
				role: "assistant" as const,
				content: [
					{ type: "text" as const, text: "Searching." },
					{ type: "text" as const, text: "Node 26 adds X." },
				],
			},
			{ role: "user" as const, content: "Thanks" },
		];

		expect(nativePrefix(records, messages)).toEqual({ records, covered: 3 });
	});
});
