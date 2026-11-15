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
});
