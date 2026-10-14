import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { type HeadlessLlmRequest, type HeadlessPi, withHeadlessPi } from "./headless-pi.ts";

async function requestRuntimeIdentity(
	agent: HeadlessPi,
	request: HeadlessLlmRequest,
	toolCallId: string,
): Promise<number> {
	agent.respondToLlmRequest(
		request.id,
		fauxAssistantMessage(fauxToolCall("test_runtime_identity", {}, { id: toolCallId }), { stopReason: "toolUse" }),
	);
	const entry = await agent.waitForSessionEntry(
		request.agentId,
		(candidate) =>
			candidate.type === "message" &&
			candidate.message.role === "toolResult" &&
			candidate.message.toolCallId === toolCallId,
	);
	if (entry.type !== "message" || entry.message.role !== "toolResult") throw new Error("Missing runtime identity");
	expect(entry.message.isError).toBe(false);
	const identity = entry.message.details as { pid: number; bun: string | null };
	expect(identity.pid).toBeGreaterThan(0);
	if (process.env.PI_HEADLESS_RUNTIME === "bun") expect(identity.bun).toEqual(expect.any(String));
	else expect(identity.bun).toBeNull();
	return identity.pid;
}

function respondWithEndTurn(agent: HeadlessPi, request: HeadlessLlmRequest): void {
	agent.respondToLlmRequest(
		request.id,
		fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Runtime identity verified" }), {
			stopReason: "toolUse",
		}),
	);
}

describe("headless Pi subprocess runtime", () => {
	it.each(["", "deno"])("rejects an invalid PI_HEADLESS_RUNTIME value %j", async (runtime) => {
		vi.stubEnv("PI_HEADLESS_RUNTIME", runtime);
		try {
			await expect(withHeadlessPi(async () => {})).rejects.toThrow("Invalid PI_HEADLESS_RUNTIME");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("persists actual runtime identity from main and lifecycle child tools under a Node test host", async () => {
		expect(process.versions).not.toHaveProperty("bun");
		await withHeadlessPi(async (agent) => {
			expect((await agent.send({ type: "prompt", message: "Report runtime, then spawn a child" })).success).toBe(
				true,
			);
			const initial = await agent.waitForLlmRequest();
			const mainPid = await requestRuntimeIdentity(agent, initial, "main-runtime-identity");
			const afterIdentity = await agent.waitForLlmRequest();
			agent.respondToLlmRequest(
				afterIdentity.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						context: "fresh",
						displayName: "Runtime child",
						prompt: "Report runtime",
					}),
					{ stopReason: "toolUse" },
				),
			);
			const child = await agent.waitForAgent((candidate) => candidate.displayName === "Runtime child");
			const childRequest = await agent.waitForLlmRequest((request) => request.agentId === child.id);
			expect(await requestRuntimeIdentity(agent, childRequest, "child-runtime-identity")).toBe(mainPid);
			const childAfterIdentity = await agent.waitForLlmRequest((request) => request.agentId === child.id);
			respondWithEndTurn(agent, childAfterIdentity);
			await agent.waitForAgent((candidate) => candidate.id === child.id && candidate.lifecycle === "completed");
		});
	});

	it("restores a persisted goal in a replacement process and completes offline Supervisor review", async () => {
		await withHeadlessPi(async (agent) => {
			await agent.send({ type: "prompt", message: "Record process identity before restart" });
			const initial = await agent.waitForLlmRequest();
			const originalPid = await requestRuntimeIdentity(agent, initial, "before-restart-runtime");
			respondWithEndTurn(agent, await agent.waitForLlmRequest());
			await agent.waitForEvent((event) => event.type === "agent_end");
			const objective = "Verify persisted goal completion after real process replacement";
			agent.writeRunningGoal(objective);
			const runningGoal = agent.readGoal();
			expect(runningGoal).toMatchObject({ objective });

			await agent.restart();

			expect(await agent.send({ type: "get_state" })).toMatchObject({
				success: true,
				data: { sessionId: agent.sessionId, sessionFile: agent.sessionFile },
			});
			expect(agent.readGoal()).toEqual(runningGoal);
			const restored = await agent.waitForLlmRequest();
			expect(await requestRuntimeIdentity(agent, restored, "after-restart-runtime")).not.toBe(originalPid);
			const afterIdentity = await agent.waitForLlmRequest();
			agent.respondToLlmRequest(
				afterIdentity.id,
				fauxAssistantMessage(
					fauxToolCall("manage_goal", {
						action: "complete",
						completionReport: "Runtime and persisted goal verified",
					}),
					{ stopReason: "toolUse" },
				),
			);
			const review = await agent.waitForSupervisorRequest("goal_completion_review");
			expect(review.payload).toMatchObject({ objective, completionReport: "Runtime and persisted goal verified" });
			agent.respondToSupervisorRequest(review, { kind: "complete", reason: "Offline proof verified" });
			const afterReview = await agent.waitForLlmRequest();
			expect(JSON.stringify(afterReview.messages)).toContain("Goal marked complete");
			respondWithEndTurn(agent, afterReview);
			await agent.waitForEvent((event) => event.type === "agent_end");
			expect(agent.readGoal()).toMatchObject({ ...runningGoal, completedAt: expect.any(String) });
			expect(agent.countSupervisorRequests("goal_completion_review")).toBe(1);
		});
	});
});
