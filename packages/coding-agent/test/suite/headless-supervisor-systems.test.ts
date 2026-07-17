import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { SupervisorResponse } from "../../src/core/session-control-db.ts";
import { withHeadlessPi } from "./headless-pi.ts";

const RUNNING_GOAL = "Finish the headless Supervisor objective";

async function startToolCall(
	approvalPreset: "llm-approved-ask" | "llm-approved-deny",
	response: SupervisorResponse,
): Promise<boolean> {
	let toolExecuted = false;
	await withHeadlessPi(
		async (agent) => {
			const toolPath = join(agent.paths.workspaceDir, "approved-write.txt");
			await agent.send({ type: "prompt", message: "Write the requested file" });
			const request = await agent.waitForLlmRequest();
			agent.respondToLlmRequest(
				request.id,
				fauxAssistantMessage(fauxToolCall("write", { path: toolPath, content: "approved" }), {
					stopReason: "toolUse",
				}),
			);
			const approval = await agent.waitForSupervisorRequest("approval_review");
			expect(approval.payload).toMatchObject({
				toolName: "write",
				input: { path: toolPath, content: "approved" },
			});
			agent.respondToSupervisorRequest(approval, response);

			if (response.kind === "approve" || approvalPreset === "llm-approved-deny") {
				const afterTool = await agent.waitForLlmRequest();
				toolExecuted = existsSync(toolPath);
				agent.respondToLlmRequest(afterTool.id, fauxAssistantMessage("Tool review finished"));
			}
		},
		{ approvalPreset },
	);
	return toolExecuted;
}

function expectRunningGoal(goal: Record<string, unknown> | undefined): void {
	expect(goal).toMatchObject({ objective: RUNNING_GOAL });
	expect(goal?.completedAt).toBeUndefined();
}

describe("headless Supervisor goal system", () => {
	it("completes an explicit manage_goal completion through the durable Supervisor boundary", async () => {
		await withHeadlessPi(async (agent) => {
			agent.writeRunningGoal(RUNNING_GOAL);
			await agent.send({ type: "prompt", message: "Complete the goal" });
			const initial = await agent.waitForLlmRequest();
			agent.respondToLlmRequest(
				initial.id,
				fauxAssistantMessage(fauxToolCall("manage_goal", { action: "complete", reason: "all proof passed" }), {
					stopReason: "toolUse",
				}),
			);

			const review = await agent.waitForSupervisorRequest("goal_completion_review");
			expect(review.payload).toMatchObject({
				objective: RUNNING_GOAL,
				proposedCompletionReason: "all proof passed",
			});
			agent.respondToSupervisorRequest(review, { kind: "complete", reason: "verified" });
			const afterTool = await agent.waitForLlmRequest();
			expect(JSON.stringify(afterTool.messages)).toContain("Goal marked complete: all proof passed");
			agent.respondToLlmRequest(afterTool.id, fauxAssistantMessage("Goal complete"));
			await agent.waitForEvent((event) => event.type === "agent_end");

			expect(agent.readGoal()).toMatchObject({ objective: RUNNING_GOAL, completedAt: expect.any(String) });
		});
	});

	it("keeps an explicit completion running and injects Supervisor continuation instructions", async () => {
		await withHeadlessPi(async (agent) => {
			agent.writeRunningGoal(RUNNING_GOAL);
			await agent.send({ type: "prompt", message: "Try to complete the goal" });
			const initial = await agent.waitForLlmRequest();
			agent.respondToLlmRequest(
				initial.id,
				fauxAssistantMessage(fauxToolCall("manage_goal", { action: "complete", reason: "looks done" }), {
					stopReason: "toolUse",
				}),
			);
			const review = await agent.waitForSupervisorRequest("goal_completion_review");
			agent.respondToSupervisorRequest(review, {
				kind: "continue",
				reason: "proof missing",
				instructions: "Run the missing headless proof.",
			});

			const afterTool = await agent.waitForLlmRequest();
			expect(JSON.stringify(afterTool.messages)).toContain("Goal remains active: proof missing");
			expectRunningGoal(agent.readGoal());
			agent.respondToLlmRequest(afterTool.id, fauxAssistantMessage("Waiting for follow-up"));
			const continuation = await agent.waitForLlmRequest();
			expect(continuation.userMessages).toContain("Run the missing headless proof.");
		});
	});

	it("requests one idle review only after the terminal post-tool response and follows continue instructions", async () => {
		await withHeadlessPi(async (agent) => {
			agent.writeRunningGoal(RUNNING_GOAL);
			const markerPath = join(agent.paths.workspaceDir, "tool-marker.txt");
			await agent.send({ type: "prompt", message: "Use a tool, then stop" });
			const initial = await agent.waitForLlmRequest();
			agent.respondToLlmRequest(
				initial.id,
				fauxAssistantMessage(fauxToolCall("write", { path: markerPath, content: "done" }), {
					stopReason: "toolUse",
				}),
			);
			const afterTool = await agent.waitForLlmRequest();
			expect(agent.countSupervisorRequests("goal_idle_review")).toBe(0);
			agent.respondToLlmRequest(afterTool.id, fauxAssistantMessage("Tool turn finished"));

			const review = await agent.waitForSupervisorRequest("goal_idle_review");
			agent.respondToSupervisorRequest(review, {
				kind: "continue",
				reason: "more work remains",
				instructions: "Continue from the idle gate.",
			});
			const continuation = await agent.waitForLlmRequest();
			expect(continuation.userMessages).toContain("Continue from the idle gate.");
			expect(agent.countSupervisorRequests("goal_idle_review")).toBe(1);
		});
	});

	it("closes a running goal when the idle review returns complete", async () => {
		await withHeadlessPi(async (agent) => {
			agent.writeRunningGoal(RUNNING_GOAL);
			await agent.send({ type: "prompt", message: "Finish normally" });
			const initial = await agent.waitForLlmRequest();
			agent.respondToLlmRequest(initial.id, fauxAssistantMessage("Finished normally"));
			const review = await agent.waitForSupervisorRequest("goal_idle_review");
			agent.respondToSupervisorRequest(review, { kind: "complete", reason: "objective verified" });
			await agent.waitForEvent((event) => event.type === "agent_end");
			expect(agent.readGoal()).toMatchObject({ objective: RUNNING_GOAL, completedAt: expect.any(String) });
		});
	});

	it("pauses a running goal when the durable Supervisor response says to wait", async () => {
		await withHeadlessPi(async (agent) => {
			agent.writeRunningGoal(RUNNING_GOAL);
			await agent.send({ type: "prompt", message: "Reach a blocked state" });
			const initial = await agent.waitForLlmRequest();
			agent.respondToLlmRequest(initial.id, fauxAssistantMessage("Blocked on user input"));
			const review = await agent.waitForSupervisorRequest("goal_idle_review");
			agent.respondToSupervisorRequest(review, { kind: "pause", reason: "waiting for user input" });
			const notification = await agent.waitForExtensionUiRequest(
				(request) => request.method === "notify" && request.message === "Goal paused: waiting for user input",
			);

			expect(notification).toMatchObject({ method: "notify", notifyType: "info" });
			expect(agent.readGoal()).toMatchObject({ objective: RUNNING_GOAL, pausedAt: expect.any(String) });
			expect(agent.countSupervisorRequests("goal_idle_review")).toBe(1);
		});
	});

	it("keeps the goal running and reports an idle Supervisor error without continuing", async () => {
		await withHeadlessPi(async (agent) => {
			agent.writeRunningGoal(RUNNING_GOAL);
			await agent.send({ type: "prompt", message: "Reach idle" });
			const initial = await agent.waitForLlmRequest();
			agent.respondToLlmRequest(initial.id, fauxAssistantMessage("Reached idle"));
			const review = await agent.waitForSupervisorRequest("goal_idle_review");
			agent.respondToSupervisorRequest(review, { kind: "error", reason: "service failed" });
			const notification = await agent.waitForExtensionUiRequest(
				(request) => request.method === "notify" && request.message.includes("service failed"),
			);
			expect(notification).toMatchObject({ method: "notify", notifyType: "error" });
			expectRunningGoal(agent.readGoal());
			expect(agent.countSupervisorRequests("goal_idle_review")).toBe(1);
		});
	});
});

describe("headless Supervisor approval system", () => {
	it("executes an approved tool call without human escalation", async () => {
		const toolExecuted = await startToolCall("llm-approved-ask", { kind: "approve", reason: "safe" });
		expect(toolExecuted).toBe(true);
	});

	it.each([
		{ response: { kind: "reject", reason: "unsafe" } as const, label: "rejection" },
		{ response: { kind: "error", reason: "service unavailable" } as const, label: "error" },
	])("escalates Supervisor $label to human review for the ask preset", async ({ response }) => {
		await withHeadlessPi(
			async (agent) => {
				const toolPath = join(agent.paths.workspaceDir, "ask-review.txt");
				await agent.send({ type: "prompt", message: "Write after review" });
				const request = await agent.waitForLlmRequest();
				agent.respondToLlmRequest(
					request.id,
					fauxAssistantMessage(fauxToolCall("write", { path: toolPath, content: "blocked" }), {
						stopReason: "toolUse",
					}),
				);
				const approval = await agent.waitForSupervisorRequest("approval_review");
				agent.respondToSupervisorRequest(approval, response);
				const humanReview = await agent.waitForExtensionUiRequest(
					(uiRequest) => uiRequest.method === "select" && uiRequest.title.startsWith("Approve write?"),
				);
				expect(humanReview).toMatchObject({ method: "select" });
				expect(existsSync(toolPath)).toBe(false);
			},
			{ approvalPreset: "llm-approved-ask" },
		);
	});

	it("blocks Supervisor rejection without human review for the deny preset", async () => {
		await withHeadlessPi(
			async (agent) => {
				const toolPath = join(agent.paths.workspaceDir, "deny-review.txt");
				await agent.send({ type: "prompt", message: "Write after review" });
				const request = await agent.waitForLlmRequest();
				agent.respondToLlmRequest(
					request.id,
					fauxAssistantMessage(fauxToolCall("write", { path: toolPath, content: "blocked" }), {
						stopReason: "toolUse",
					}),
				);
				const approval = await agent.waitForSupervisorRequest("approval_review");
				agent.respondToSupervisorRequest(approval, { kind: "reject", reason: "unsafe" });
				const afterTool = await agent.waitForLlmRequest();
				expect(JSON.stringify(afterTool.messages)).toContain("unsafe");
				expect(existsSync(toolPath)).toBe(false);
				expect(agent.countExtensionUiRequests((uiRequest) => uiRequest.method === "select")).toBe(0);
				agent.respondToLlmRequest(afterTool.id, fauxAssistantMessage("Blocked as expected"));
			},
			{ approvalPreset: "llm-approved-deny" },
		);
	});

	it("escalates Supervisor error to human review for the deny preset", async () => {
		await withHeadlessPi(
			async (agent) => {
				const toolPath = join(agent.paths.workspaceDir, "deny-error-review.txt");
				await agent.send({ type: "prompt", message: "Write after review" });
				const request = await agent.waitForLlmRequest();
				agent.respondToLlmRequest(
					request.id,
					fauxAssistantMessage(fauxToolCall("write", { path: toolPath, content: "blocked" }), {
						stopReason: "toolUse",
					}),
				);
				const approval = await agent.waitForSupervisorRequest("approval_review");
				agent.respondToSupervisorRequest(approval, { kind: "error", reason: "service unavailable" });
				const humanReview = await agent.waitForExtensionUiRequest(
					(uiRequest) => uiRequest.method === "select" && uiRequest.title.startsWith("Approve write?"),
				);
				expect(humanReview).toMatchObject({ method: "select" });
				expect(existsSync(toolPath)).toBe(false);
			},
			{ approvalPreset: "llm-approved-deny" },
		);
	});
});
