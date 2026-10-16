import { unlinkSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import {
	getControlDbPath,
	readMultiAgentRuntimeOwnership,
	readRuntimeMailboxListener,
} from "../../../src/core/session-control-db.ts";
import { createSqliteDatabase } from "../../../src/core/sqlite.ts";
import { type HeadlessPi, requireHeadlessAgentSessionId, withHeadlessPi } from "../headless-pi.ts";

function fauxCompletedAssistantMessage(text: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })], {
		stopReason: "toolUse",
	});
}

function seedMailboxRetentionRegression(pi: HeadlessPi): void {
	const db = createSqliteDatabase(getControlDbPath(pi.paths.agentDir));
	const now = Date.now();
	const old = new Date(now - 25 * 60 * 60 * 1000).toISOString();
	const fresh = new Date(now).toISOString();
	const statuses = ["pending", "claimed", "accepted", "rejected", "delivered", "failed"];
	const entries = [
		...statuses.map((status) => ({ status, createdAt: old })),
		{ status: "pending", createdAt: undefined },
		{ status: "pending", createdAt: "invalid" },
		{ status: "delivered", createdAt: fresh },
	];
	try {
		const insert = db.prepare(
			"INSERT INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at) VALUES (?, ?, ?, ?)",
		);
		for (const [index, entry] of entries.entries()) {
			const id = `retention-regression-${index}`;
			const payload = JSON.stringify({
				...entry,
				body: "Expired retention-regression input must not replay",
				fromAgentId: "main",
				id,
				kind: "message",
				recipientAgentId: null,
				recipientSessionId: pi.sessionId,
				senderAgentId: null,
				senderSessionId: pi.sessionId,
				toAgentId: "main",
				updatedAt: fresh,
			});
			insert.run(pi.sessionFile, id, payload, fresh);
			if (entry.createdAt === undefined) {
				// New undated inserts receive a birth timestamp. Restore the legacy snapshot
				// afterward so startup cleanup sees an already-existing undated record.
				db.prepare(
					"UPDATE multi_agent_mailbox_messages SET data = ? WHERE session_path = ? AND message_id = ?",
				).run(payload, pi.sessionFile, id);
			}
		}
	} finally {
		db.close();
	}
}

function readMailboxRetentionRegressionIds(pi: HeadlessPi): string[] {
	const db = createSqliteDatabase(getControlDbPath(pi.paths.agentDir));
	try {
		const rows = db
			.prepare(
				"SELECT message_id FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id LIKE 'retention-regression-%' ORDER BY message_id",
			)
			.all(pi.sessionFile) as Array<{ message_id: string }>;
		return rows.map((row) => row.message_id);
	} finally {
		db.close();
	}
}

async function waitForGoalIdleReviewRequest(pi: HeadlessPi): Promise<void> {
	await vi.waitFor(() => expect(pi.countSupervisorRequests("goal_idle_review")).toBe(1));
}

function expectNoAgentJournal(pi: HeadlessPi, agentId: string): void {
	for (const sessionAgentId of [null, agentId]) {
		expect(
			pi
				.readSessionEntries(sessionAgentId)
				.filter(
					(entry) =>
						entry.type === "custom" &&
						(entry.customType === "agent_start" || entry.customType === "agent_complete"),
				),
		).toEqual([]);
	}
}

describe("sub-agent ControlDB restart recovery", () => {
	it("keeps a spawned child visible and its listener alive through completion report routing", async () => {
		await withHeadlessPi(async (pi) => {
			await pi.send({ type: "prompt", message: "Spawn a child and inspect it immediately" });
			const initialMainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(
				initialMainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						context: "fresh",
						displayName: "Immediate visibility child",
						prompt: "Wait, then return: visibility complete",
					}),
					{ stopReason: "toolUse" },
				),
			);

			const spawned = await pi.waitForAgent((agent) => agent.displayName === "Immediate visibility child");
			const childRequest = await pi.waitForLlmRequest((request) => request.agentId === spawned.id);
			const childSessionId = spawned.transcript?.sessionId;
			if (!childSessionId) throw new Error("Immediate visibility child has no child session ID");
			const controlDbPath = getControlDbPath(pi.paths.agentDir);
			const childRecipient = { agentId: spawned.id, sessionId: childSessionId };
			const parentRecipient = { agentId: null, sessionId: pi.sessionId };
			expect(readRuntimeMailboxListener(controlDbPath, childRecipient)).toBeDefined();
			expect(readRuntimeMailboxListener(controlDbPath, parentRecipient)).toBeDefined();

			const mainAfterSpawn = await pi.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== initialMainRequest.id,
			);
			pi.respondToLlmRequest(
				mainAfterSpawn.id,
				fauxAssistantMessage(fauxToolCall("list_agents", {}), { stopReason: "toolUse" }),
			);
			const listResult = await pi.waitForSessionEntry(
				null,
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolName === "list_agents",
			);
			expect(JSON.stringify(listResult)).toContain(spawned.id);
			const mainAfterList = await pi.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== mainAfterSpawn.id,
			);
			pi.respondToLlmRequest(mainAfterList.id, fauxCompletedAssistantMessage("Child remains visible"));

			pi.respondToLlmRequest(childRequest.id, fauxCompletedAssistantMessage("visibility complete"));
			await pi.waitForAgent((agent) => agent.id === spawned.id && agent.lifecycle === "completed");
			await vi.waitFor(() => expect(readRuntimeMailboxListener(controlDbPath, childRecipient)).toBeUndefined());
			expect(readRuntimeMailboxListener(controlDbPath, parentRecipient)).toBeDefined();

			const completionRequest = await pi.waitForLlmRequest(
				(request) =>
					request.agentId === null &&
					request.userMessages.some((message) => message.includes("visibility complete")),
			);
			expect(completionRequest.userMessages).toContainEqual(expect.stringContaining("visibility complete"));
			pi.respondToLlmRequest(completionRequest.id, fauxCompletedAssistantMessage("Completion report received"));
		});
	});

	it("steers a live child with a registered listener without restarting Pi", async () => {
		await withHeadlessPi(async (pi) => {
			await pi.send({ type: "prompt", message: "Start a child, then steer it without restarting" });
			const mainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(
				mainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						context: "fresh",
						displayName: "Live steering target",
						prompt: "Wait for steering",
					}),
					{ stopReason: "toolUse" },
				),
			);
			const spawned = await pi.waitForAgent((agent) => agent.displayName === "Live steering target");
			const initialChildRequest = await pi.waitForLlmRequest((request) => request.agentId === spawned.id);
			const childSessionId = spawned.transcript?.sessionId;
			if (!childSessionId) throw new Error("Live steering target has no child session ID");
			const recipient = { agentId: spawned.id, sessionId: childSessionId };
			const controlDbPath = getControlDbPath(pi.paths.agentDir);
			const beforeSteer = pi.listAgents().find((agent) => agent.id === spawned.id);
			const listenerBeforeSteer = readRuntimeMailboxListener(controlDbPath, recipient);
			expect(beforeSteer?.lifecycle).toBe("running");
			expect(listenerBeforeSteer).toBeDefined();

			const mainAfterSpawn = await pi.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== mainRequest.id,
			);
			pi.respondToLlmRequest(
				mainAfterSpawn.id,
				fauxAssistantMessage(
					fauxToolCall("steer_agent", {
						agentId: spawned.id,
						message: "Apply this live steering message",
					}),
					{ stopReason: "toolUse" },
				),
			);
			await pi.waitForAgent((agent) => agent.id === spawned.id && agent.lifecycle === "steering_pending");
			expect(readRuntimeMailboxListener(controlDbPath, recipient)).toBeDefined();
			pi.respondToLlmRequest(initialChildRequest.id, fauxCompletedAssistantMessage("Initial child turn complete"));
			const steeredRequest = await pi.waitForLlmRequest(
				(request) => request.agentId === spawned.id && request.id !== initialChildRequest.id,
			);
			expect(steeredRequest.userMessages).toContainEqual(
				expect.stringContaining("Apply this live steering message"),
			);
			pi.respondToLlmRequest(steeredRequest.id, fauxCompletedAssistantMessage("Steering delivered"));
		});
	});

	it("reports a terminal child as inactive when its listener retires before a stale steering request", async () => {
		await withHeadlessPi(async (pi) => {
			await pi.send({ type: "prompt", message: "Start a child that completes before stale steering" });
			const mainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(
				mainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						context: "fresh",
						displayName: "Terminal steering target",
						prompt: "Complete now",
					}),
					{ stopReason: "toolUse" },
				),
			);
			const spawned = await pi.waitForAgent((agent) => agent.displayName === "Terminal steering target");
			const childRequest = await pi.waitForLlmRequest((request) => request.agentId === spawned.id);
			const mainAfterSpawn = await pi.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== mainRequest.id,
			);
			const childSessionId = spawned.transcript?.sessionId;
			if (!childSessionId) throw new Error("Terminal steering target has no child session ID");
			const recipient = { agentId: spawned.id, sessionId: childSessionId };
			const controlDbPath = getControlDbPath(pi.paths.agentDir);
			expect(pi.listAgents().find((agent) => agent.id === spawned.id)?.lifecycle).toBe("running");
			expect(readRuntimeMailboxListener(controlDbPath, recipient)).toBeDefined();

			pi.respondToLlmRequest(childRequest.id, fauxCompletedAssistantMessage("Completed before steering"));
			await pi.waitForAgent((agent) => agent.id === spawned.id && agent.lifecycle === "completed");
			expect(pi.listAgents().find((agent) => agent.id === spawned.id)?.lifecycle).toBe("completed");
			await vi.waitFor(() => expect(readRuntimeMailboxListener(controlDbPath, recipient)).toBeUndefined());

			pi.respondToLlmRequest(
				mainAfterSpawn.id,
				fauxAssistantMessage(
					fauxToolCall("steer_agent", { agentId: spawned.id, message: "This steering is stale" }),
					{ stopReason: "toolUse" },
				),
			);
			const steerResult = await pi.waitForSessionEntry(
				null,
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolName === "steer_agent",
			);
			expect(JSON.stringify(steerResult)).toContain("inactive");
			expect(JSON.stringify(steerResult)).not.toContain("mutation_mismatch");
		});
	});

	it("recovers steering pending ownership after an in-place supervisor restart", async () => {
		await withHeadlessPi(async (pi) => {
			pi.writeRunningGoal("Finish after the live reviewer is recovered");
			await pi.send({ type: "prompt", message: "Start a reviewer, steer it, then restart in place" });
			const mainRequest = await pi
				.waitForLlmRequest((request) => request.agentId === null)
				.catch((error: unknown) => {
					throw new Error(`Initial main request missing: ${String(error)}`);
				});
			pi.respondToLlmRequest(
				mainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						context: "fresh",
						displayName: "In-place restart reviewer",
						prompt: "Wait for steering",
					}),
					{ stopReason: "toolUse" },
				),
			);
			const spawned = await pi.waitForAgent((agent) => agent.displayName === "In-place restart reviewer");
			const childSessionId = requireHeadlessAgentSessionId(spawned);
			await pi
				.waitForLlmRequest((request) => request.sessionId === childSessionId)
				.catch((error: unknown) => {
					throw new Error(
						`Initial child request missing: ${String(error)} agents=${JSON.stringify(pi.listAgents())}`,
					);
				});
			const mainAfterSpawn = await pi
				.waitForLlmRequest((request) => request.agentId === null && request.id !== mainRequest.id)
				.catch((error: unknown) => {
					throw new Error(`Main request after spawn missing: ${String(error)}`);
				});
			pi.respondToLlmRequest(
				mainAfterSpawn.id,
				fauxAssistantMessage(
					fauxToolCall("steer_agent", { agentId: spawned.id, message: "Finish the review after restart" }),
					{ stopReason: "toolUse" },
				),
			);
			await pi.waitForAgent((agent) => agent.id === spawned.id && agent.lifecycle === "steering_pending");
			const controlDbPath = getControlDbPath(pi.paths.agentDir);
			const ownershipBefore = readMultiAgentRuntimeOwnership(controlDbPath, pi.sessionFile, spawned.id);
			if (!ownershipBefore?.processIdentity) throw new Error("Reviewer has no runtime ownership");
			const mainAfterSteer = await pi
				.waitForLlmRequest((request) => request.agentId === null && request.id !== mainAfterSpawn.id)
				.catch((error: unknown) => {
					throw new Error(`Main turn did not continue after steering: ${String(error)}`);
				});
			pi.respondToLlmRequest(mainAfterSteer.id, fauxCompletedAssistantMessage("Waiting for the reviewer"));
			await waitForGoalIdleReviewRequest(pi);
			void pi.send({ type: "prompt", message: "/restart" }).catch(() => undefined);

			const restoredChildRequest = await pi
				.waitForLlmRequest((request) => request.sessionId === childSessionId)
				.catch((error: unknown) => {
					throw new Error(
						`Child recovery did not resume: ${String(error)} agents=${JSON.stringify(pi.listAgents())} entries=${JSON.stringify(pi.readSessionEntries(null).slice(-5))}`,
					);
				});
			expect(pi.listAgents().find((agent) => agent.id === spawned.id)?.lifecycle).toBe("steering_pending");
			const ownershipAfter = readMultiAgentRuntimeOwnership(controlDbPath, pi.sessionFile, spawned.id);
			expect(ownershipAfter?.processIdentity).toMatchObject({
				pid: ownershipBefore.processIdentity.pid,
				startTimeTicks: ownershipBefore.processIdentity.startTimeTicks,
			});
			expect(ownershipAfter?.processIdentity?.incarnation).not.toBe(ownershipBefore.processIdentity.incarnation);

			pi.respondToLlmRequest(restoredChildRequest.id, fauxCompletedAssistantMessage("Recovery turn complete"));
			const steeredChildRequest = await pi.waitForLlmRequest(
				(request) => request.agentId === spawned.id && request.id !== restoredChildRequest.id,
			);
			expect(steeredChildRequest.userMessages).toContainEqual(
				expect.stringContaining("Finish the review after restart"),
			);
			pi.respondToLlmRequest(steeredChildRequest.id, fauxCompletedAssistantMessage("Recovered review complete"));
			await pi.waitForAgent((agent) => agent.id === spawned.id && agent.lifecycle === "completed");
			const review = await pi.waitForSupervisorRequest("goal_idle_review");
			expect(review.kind).toBe("goal_idle_review");
			expect(pi.countSupervisorRequests("goal_idle_review")).toBe(1);
		});
	});

	it("restores the same DB child and completes once without journal writes after a supervisor crash", async () => {
		await withHeadlessPi(async (pi) => {
			await pi.send({ type: "prompt", message: "Start a reviewer that survives restart" });
			const mainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(
				mainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						context: "fresh",
						displayName: "Restart-persisted reviewer",
						prompt: "Review until Pi restarts",
					}),
					{ stopReason: "toolUse" },
				),
			);

			const spawned = await pi.waitForAgent((agent) => agent.displayName === "Restart-persisted reviewer");
			const childSessionId = requireHeadlessAgentSessionId(spawned);
			const transcriptPath = spawned.transcript?.path;
			expect(transcriptPath).toBeDefined();
			expectNoAgentJournal(pi, spawned.id);

			await pi.waitForLlmRequest((request) => request.sessionId === childSessionId);
			await pi.crash();
			seedMailboxRetentionRegression(pi);
			expect(readMailboxRetentionRegressionIds(pi)).toHaveLength(9);
			await pi.restart();

			const restoredRequest = await pi.waitForLlmRequest((request) => request.sessionId === childSessionId);
			const restored = pi.listAgents().find((agent) => agent.id === spawned.id);
			expect(restored).toMatchObject({
				id: spawned.id,
				lifecycle: "running",
				transcript: { sessionId: childSessionId, path: transcriptPath },
			});

			const restoredMainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
			expect(restoredMainRequest.userMessages.join("\n")).not.toContain("Expired retention-regression input");
			pi.respondToLlmRequest(restoredMainRequest.id, fauxCompletedAssistantMessage("Supervisor restored"));
			pi.respondToLlmRequest(restoredRequest.id, fauxCompletedAssistantMessage("Recovered review complete"));
			await pi.waitForAgent((agent) => agent.id === spawned.id && agent.lifecycle === "completed");

			expect(restoredRequest.userMessages).toContain("Review until Pi restarts");
			const completionRequest = await pi.waitForLlmRequest(
				(request) =>
					request.agentId === null &&
					request.userMessages.some((message) => message.includes("Recovered review complete")),
			);
			expect(
				completionRequest.userMessages.filter((message) => message.includes("Recovered review complete")),
			).toHaveLength(1);
			pi.respondToLlmRequest(completionRequest.id, fauxCompletedAssistantMessage("Recovered report received"));
			await pi.waitForSessionEntry(
				null,
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolName === "end_turn" &&
					JSON.stringify(entry.message).includes("Recovered report received"),
			);
			expect(
				pi
					.readSessionEntries(null)
					.filter(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							JSON.stringify(entry.message).includes("Recovered review complete"),
					),
			).toHaveLength(1);
			expect(pi.listAgents().filter((agent) => agent.id === spawned.id)).toHaveLength(1);
			expectNoAgentJournal(pi, spawned.id);
			await vi.waitFor(() => expect(readMailboxRetentionRegressionIds(pi)).toEqual(["retention-regression-8"]));
		});
	});

	it("recovers a dead-owned DB child without any parent restart journal", async () => {
		await withHeadlessPi(async (pi) => {
			await pi.send({ type: "prompt", message: "Start a DB-only child" });
			const mainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(
				mainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						context: "fresh",
						displayName: "Unjournaled child",
						prompt: "Wait for restart",
					}),
					{ stopReason: "toolUse" },
				),
			);
			const spawned = await pi.waitForAgent((agent) => agent.displayName === "Unjournaled child");
			await pi.waitForLlmRequest((request) => request.agentId === spawned.id);
			expectNoAgentJournal(pi, spawned.id);
			await pi.waitForSessionEntry(
				null,
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolName === "spawn_agent",
			);
			await pi.crash();
			await pi.restart();

			const recovered = await pi.waitForLlmRequest((request) => request.agentId === spawned.id);
			expect(recovered.sessionId).toBe(requireHeadlessAgentSessionId(spawned));
			expect(recovered.userMessages).toContain("Wait for restart");
			expect(pi.listAgents().find((agent) => agent.id === spawned.id)).toMatchObject({
				lifecycle: "running",
				transcript: spawned.transcript,
			});
			pi.respondToLlmRequest(recovered.id, fauxCompletedAssistantMessage("Unjournaled recovery complete"));
			await pi.waitForAgent((agent) => agent.id === spawned.id && agent.lifecycle === "completed");
			expectNoAgentJournal(pi, spawned.id);
		});
	});

	it("persists a failed DB child without journal writes when recovery cannot open its transcript", async () => {
		await withHeadlessPi(async (pi) => {
			await pi.send({ type: "prompt", message: "Start a child whose transcript will be lost" });
			const mainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(
				mainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						context: "fresh",
						displayName: "Failing child",
						prompt: "Wait for restart",
					}),
					{ stopReason: "toolUse" },
				),
			);
			const spawned = await pi.waitForAgent((agent) => agent.displayName === "Failing child");
			await pi.waitForLlmRequest((request) => request.agentId === spawned.id);
			const transcriptPath = spawned.transcript?.path;
			if (!transcriptPath) throw new Error("Failing child has no transcript path");
			await pi.crash();
			unlinkSync(transcriptPath);
			await pi.restart();
			const failed = await pi.waitForAgent((agent) => agent.id === spawned.id && agent.lifecycle === "failed");
			expect(failed.transcript).toEqual(spawned.transcript);
			expect(
				pi
					.readSessionEntries(null)
					.filter(
						(entry) =>
							entry.type === "custom" &&
							(entry.customType === "agent_start" || entry.customType === "agent_complete"),
					),
			).toEqual([]);
		});
	});

	it("persists an aborted DB child without journal writes", async () => {
		await withHeadlessPi(async (pi) => {
			await pi.send({ type: "prompt", message: "Start and cancel a child" });
			const mainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(
				mainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						context: "fresh",
						displayName: "Cancelled child",
						prompt: "Wait for cancellation",
					}),
					{ stopReason: "toolUse" },
				),
			);
			const spawned = await pi.waitForAgent((agent) => agent.displayName === "Cancelled child");
			await pi.waitForLlmRequest((request) => request.agentId === spawned.id);
			const afterSpawn = await pi.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== mainRequest.id,
			);
			pi.respondToLlmRequest(
				afterSpawn.id,
				fauxAssistantMessage(fauxToolCall("close_agent", { agentId: spawned.id }), { stopReason: "toolUse" }),
			);
			await pi.waitForAgent((agent) => agent.id === spawned.id && agent.lifecycle === "aborted");
			expectNoAgentJournal(pi, spawned.id);
		});
	});

	it("does not resurrect a DB-terminal child after restart without journal records", async () => {
		await withHeadlessPi(async (pi) => {
			await pi.send({ type: "prompt", message: "Complete a child before restart" });
			const mainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(
				mainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						context: "fresh",
						displayName: "Completed child",
						prompt: "Complete now",
					}),
					{ stopReason: "toolUse" },
				),
			);
			const spawned = await pi.waitForAgent((agent) => agent.displayName === "Completed child");
			const childRequest = await pi.waitForLlmRequest((request) => request.agentId === spawned.id);
			pi.respondToLlmRequest(childRequest.id, fauxCompletedAssistantMessage("Done before restart"));
			await pi.waitForAgent((agent) => agent.id === spawned.id && agent.lifecycle === "completed");
			expectNoAgentJournal(pi, spawned.id);

			await pi.crash();
			await pi.restart();
			const restoredMainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(restoredMainRequest.id, fauxCompletedAssistantMessage("Supervisor restored"));
			expect(pi.listAgents().find((agent) => agent.id === spawned.id)?.lifecycle).toBe("completed");
			const recovered = await Promise.race([
				pi
					.waitForLlmRequest((request) => request.agentId === spawned.id)
					.then(() => true)
					.catch(() => false),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
			]);
			expect(recovered).toBe(false);
			expect(pi.listAgents().find((agent) => agent.id === spawned.id)?.transcript).toEqual(spawned.transcript);
			expectNoAgentJournal(pi, spawned.id);
		});
	});
});
