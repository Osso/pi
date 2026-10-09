import { describe, expect, it } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";

const OBJECTIVE = "Process steering without goal review at the interrupted boundary";

describe("goal steering idle boundary", () => {
	it.each(["steer", "prompt"] as const)("silently replaces active thinking through RPC %s", async (type) => {
		await withHeadlessPi(
			async (agent) => {
				agent.writeRunningGoal(OBJECTIVE);
				expect((await agent.send({ type: "set_thinking_level", level: "high" })).success).toBe(true);
				expect((await agent.send({ type: "prompt", message: "Initial goal work" })).success).toBe(true);
				await agent.waitForLlmRequest();

				const text = "Replace the current thinking with this instruction";
				const command =
					type === "steer"
						? { type, message: text }
						: { type, message: text, streamingBehavior: "steer" as const };
				expect((await agent.send(command)).success).toBe(true);
				const interrupted = await agent.waitForEvent((event) => event.type === "agent_end");
				expect(interrupted).toMatchObject({ messages: [expect.objectContaining({ stopReason: "aborted" })] });
				const replacement = await agent.waitForLlmRequest();
				expect(replacement.userMessages).toEqual(["Initial goal work", text]);
				expect(agent.countSupervisorRequests("goal_idle_review")).toBe(0);
				expect(agent.countSupervisorRequests("goal_completion_review")).toBe(0);
				expect(
					agent
						.readSessionEntries(null)
						.filter((entry) => entry.type === "custom" && entry.customType === "supervisor-status"),
				).toEqual([]);
				expect(agent.readGoal()).toMatchObject({ objective: OBJECTIVE });
				expect(agent.readGoal()).not.toHaveProperty("pausedAt");
				expect(agent.readGoal()).not.toHaveProperty("completedAt");
			},
			{ model: "headless-faux-reasoning" },
		);
	});

	it("preserves explicit abort status without pending input", async () => {
		await withHeadlessPi(async (agent) => {
			agent.writeRunningGoal(OBJECTIVE);
			expect((await agent.send({ type: "prompt", message: "Abort without replacement input" })).success).toBe(true);
			await agent.waitForLlmRequest();
			expect((await agent.send({ type: "abort" })).success).toBe(true);
			await agent.waitForEvent((event) => event.type === "agent_end");
			const statuses = agent
				.readSessionEntries(null)
				.filter((entry) => entry.type === "custom" && entry.customType === "supervisor-status");
			expect(statuses).toEqual([
				expect.objectContaining({
					data: expect.objectContaining({ message: "Goal continuation skipped: the model turn was aborted." }),
				}),
			]);
			expect(agent.countSupervisorRequests("goal_idle_review")).toBe(0);
			expect(agent.readGoal()).toMatchObject({ objective: OBJECTIVE });
			expect(agent.readGoal()).not.toHaveProperty("pausedAt");
			expect(agent.readGoal()).not.toHaveProperty("completedAt");
		});
	});
});
