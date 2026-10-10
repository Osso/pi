import { describe, expect, it } from "vitest";
import { formatSharedChannelPrompt } from "../src/core/runtime-coordination-format.ts";

describe("runtime coordination formatting", () => {
	it("includes the imported origin host and session for cross-host replies", () => {
		const prompt = formatSharedChannelPrompt(
			[
				{
					id: 3,
					originHost: "agent-server",
					originId: 9,
					sender: { sessionId: "same-session-id", agentId: null },
					body: "Restart /tmp/shared",
					createdAt: "2026-10-09T00:00:00.000Z",
				},
			],
			"same-session-id",
		);
		expect(prompt).toContain("- host: agent-server (reply with toHost and toSessionId)");
		expect(prompt).toContain("- session: same-session-id");
		expect(prompt).toContain("Restart /tmp/shared");
	});
	it("adds mandatory receive-side policy while preserving shared-channel sender and body formatting", () => {
		const prompt = formatSharedChannelPrompt(
			[
				{
					id: 1,
					sender: { agentId: null, sessionId: "sender-session" },
					body: "Restart onto the installed runtime",
					createdAt: "2026-08-27T00:00:00.000Z",
				},
				{
					id: 2,
					sender: { agentId: null, sessionId: "recipient-session" },
					body: "Do not echo this diagnostic test",
					createdAt: "2026-08-27T00:00:01.000Z",
				},
			],
			"recipient-session",
		);

		expect(prompt).toContain("Do not acknowledge, restate, relay, summarize, or review channel messages.");
		expect(prompt).toContain("Do not confirm, praise, or classify them through channel_post.");
		expect(prompt).toContain(
			"Take no action unless the message requests action from you or its affected path or artifact overlaps your work.",
		);
		expect(prompt).toContain("Never echo diagnostic or test messages onto the shared channel.");
		expect(prompt).toContain(
			"Correct misuse only when needed to stop an immediate or repeated coordination hazard, using one terse targeted command.",
		);
		expect(prompt).toContain(
			[
				"From shared channel:",
				"- session: sender-session",
				"- agent: main",
				"",
				"Message:",
				"Restart onto the installed runtime",
				"",
				"From shared channel:",
				"- agent: main",
				"",
				"Message:",
				"Do not echo this diagnostic test",
			].join("\n"),
		);
	});
});
