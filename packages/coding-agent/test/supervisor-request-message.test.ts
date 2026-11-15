import { describe, expect, it } from "vitest";
import { formatSupervisorRequestPrompt } from "../extensions/supervisor-session/src/request-message.ts";
import type { SupervisorRequest } from "../src/core/session-control-db.ts";
import { buildSupervisorPrompt } from "../src/supervisor/service.ts";

function request(overrides: Partial<SupervisorRequest>): SupervisorRequest {
	return {
		id: 7,
		kind: "goal_idle_review",
		payload: {},
		projectId: "pi",
		senderSessionId: "01a1dc13-c862",
		deadlineAt: "2026-11-15T01:20:00.000Z",
		createdAt: "2026-11-15T01:05:00.000Z",
		status: "claimed",
		...overrides,
	};
}

describe("Supervisor request display", () => {
	it("shows a goal review as labeled fields without user messages or objective, and splits off the instructions", () => {
		const prompt = buildSupervisorPrompt(
			request({
				payload: {
					objective: "Ship the relay\nwith tests",
					userMessages: ["secret chat line"],
					recentTools: [{ toolName: "bash", isError: false }],
				},
			}),
		);

		const display = formatSupervisorRequestPrompt(prompt);

		expect(display.title).toBe("Goal idle review");
		expect(display.body).toBe(
			[
				"Project: pi",
				"From session: 01a1dc13-c862",
				"Deadline: 2026-11-15T01:20:00.000Z",
				"Recent tools:",
				"  - Tool name: bash",
				"    Is error: false",
			].join("\n"),
		);
		expect(display.body).not.toContain("secret chat line");
		expect(display.body).not.toContain("Ship the relay");
		expect(display.body).not.toContain("{");
		expect(display.instructions).toContain("Call supervisor_response with kind complete");
		expect(display.instructions).not.toContain("Request:");
	});

	it("lists questions with their options", () => {
		const display = formatSupervisorRequestPrompt(
			buildSupervisorPrompt(
				request({
					kind: "question",
					payload: { blocking: true, questions: [{ question: "Which runner?", options: [{ label: "vitest" }] }] },
				}),
			),
		);

		expect(display.title).toBe("Question");
		expect(display.body).toContain(
			["Blocking: true", "Questions:", "  - Question: Which runner?", "    Options:", "      - Label: vitest"].join(
				"\n",
			),
		);
	});
});
