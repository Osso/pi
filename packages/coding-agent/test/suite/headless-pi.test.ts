import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { getControlDbPath, readMultiAgentRuntimeOwnership } from "../../src/core/session-control-db.ts";
import type { CustomEntry, SessionMessageEntry } from "../../src/core/session-manager.ts";
import {
	cleanupHeadlessPiResources,
	cleanupHeadlessRuntimeResources,
	createHeadlessPaths,
	type HeadlessLlmRequest,
	type HeadlessPi,
	runWithCleanup,
	withHeadlessPi,
} from "./headless-pi.ts";

async function waitForFileContent(path: string, expected: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (existsSync(path) && readFileSync(path, "utf8") === expected) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${path} to contain ${expected}`);
}

function expectSingleToolResult(request: HeadlessLlmRequest, expectedOutput: string): void {
	expect(request.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
	expect(JSON.stringify(request.messages)).toContain(expectedOutput);
}

function expectSingleFailedToolResult(request: HeadlessLlmRequest, expectedOutput: string): void {
	const results = request.messages.filter((message) => message.role === "toolResult");
	expect(results).toHaveLength(1);
	expect(results[0]).toMatchObject({ isError: true });
	expect(JSON.stringify(results[0])).toContain(expectedOutput);
}

function expectFailedToolEntry(entry: SessionMessageEntry, expectedOutput: string): void {
	expect(entry.message).toMatchObject({ isError: true, role: "toolResult" });
	expect(JSON.stringify(entry.message)).toContain(expectedOutput);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function killProcessGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		process.kill(pid, "SIGKILL");
	}
}

async function spawnPendingHeadlessChild(agent: HeadlessPi, displayName: string, agentType?: string) {
	const promptResponse = await agent.send({ type: "prompt", message: `Spawn ${displayName}` });
	if (!("success" in promptResponse) || !promptResponse.success) {
		throw new Error(`Initial prompt rejected: ${JSON.stringify(promptResponse)}`);
	}
	const initialMainRequest = await agent
		.waitForLlmRequest((request) => request.agentId === null)
		.catch((error: unknown) => {
			throw new Error(`Initial main request missing: ${error instanceof Error ? error.message : String(error)}`);
		});
	agent.respondToLlmRequest(
		initialMainRequest.id,
		fauxAssistantMessage(
			fauxToolCall("spawn_agent", { agentType, displayName, prompt: `Remain live for ${displayName}` }),
			{
				stopReason: "toolUse",
			},
		),
	);
	const spawned = await agent.waitForAgent((candidate) => candidate.displayName === displayName);
	const childRequest = await agent
		.waitForLlmRequest((request) => request.agentId === spawned.id)
		.catch((error: unknown) => {
			throw new Error(`Child request missing: ${error instanceof Error ? error.message : String(error)}`);
		});
	const mainAfterSpawn = await agent
		.waitForLlmRequest((request) => request.agentId === null && request.id !== initialMainRequest.id)
		.catch((error: unknown) => {
			throw new Error(`Post-spawn main request missing: ${error instanceof Error ? error.message : String(error)}`);
		});
	return { childRequest, mainAfterSpawn, spawned };
}

async function selectAndMutateHeadlessTarget(
	agent: HeadlessPi,
	request: HeadlessLlmRequest,
	agentId: string,
	toolName: "test_set_viewed_model" | "test_set_viewed_effort",
): Promise<SessionMessageEntry> {
	agent.respondToLlmRequest(
		request.id,
		fauxAssistantMessage(
			fauxToolCall("pyrun_eval", { code: `print(pi.agents.select(${JSON.stringify(agentId)}))` }),
			{ stopReason: "toolUse" },
		),
	);
	const selectionEntry = await agent.waitForSessionEntry(
		null,
		(candidate) =>
			candidate.type === "message" &&
			candidate.message.role === "toolResult" &&
			candidate.message.toolName === "pyrun_eval",
	);
	if (selectionEntry.type !== "message") throw new Error("Expected Pyrun selection result entry");
	const afterSelection = await agent
		.waitForLlmRequest((candidate) => candidate.agentId === null && candidate.id !== request.id)
		.catch((error: unknown) => {
			throw new Error(`Selection did not continue: ${error instanceof Error ? error.message : String(error)}`);
		});
	agent.respondToLlmRequest(
		afterSelection.id,
		fauxAssistantMessage(fauxToolCall(toolName, {}), { stopReason: "toolUse" }),
	);
	const entry = await agent.waitForSessionEntry(
		null,
		(candidate) =>
			candidate.type === "message" &&
			candidate.message.role === "toolResult" &&
			candidate.message.toolName === toolName,
	);
	if (entry.type !== "message") throw new Error(`Expected ${toolName} result entry`);
	return entry;
}

describe("headless Pi fixture", () => {
	it("removes partial fixture state when path setup fails", () => {
		const removeTempDir = vi.fn();
		expect(() =>
			createHeadlessPaths({
				createTempDir: () => "/tmp/pi-headless-setup-failure",
				createDirectory: () => {},
				writeModelsJson: () => {
					throw new Error("models write failed");
				},
				removeTempDir,
			}),
		).toThrow("models write failed");
		expect(removeTempDir).toHaveBeenCalledWith("/tmp/pi-headless-setup-failure");
	});

	it("removes fixture state even when process and server cleanup fail", async () => {
		const removeTempDir = vi.fn();
		await expect(
			cleanupHeadlessPiResources({
				stopClient: async () => {
					throw new Error("stop failed");
				},
				destroyProviderSocket: () => {},
				closeProviderServer: async () => {
					throw new Error("close failed");
				},
				removeTempDir,
			}),
		).rejects.toThrow(AggregateError);
		expect(removeTempDir).toHaveBeenCalledOnce();
	});

	it("cleans primary fixture resources when shared-session cleanup fails", async () => {
		const cleanupPrimary = vi.fn(async () => {
			throw new Error("primary cleanup failed");
		});
		await expect(
			cleanupHeadlessRuntimeResources(
				[
					async () => {
						throw new Error("shared cleanup failed");
					},
				],
				cleanupPrimary,
			),
		).rejects.toMatchObject({
			errors: [
				expect.objectContaining({ message: "shared cleanup failed" }),
				expect.objectContaining({ message: "primary cleanup failed" }),
			],
		});
		expect(cleanupPrimary).toHaveBeenCalledOnce();
	});

	it("preserves undefined scenario and cleanup failures", async () => {
		await expect(
			runWithCleanup(
				async () => {
					throw undefined;
				},
				async () => {},
			),
		).rejects.toBeUndefined();
		await expect(
			runWithCleanup(
				async () => "result",
				async () => {
					throw undefined;
				},
			),
		).rejects.toBeUndefined();
	});

	it("preserves both scenario and cleanup failures", async () => {
		await expect(
			runWithCleanup(
				async () => {
					throw new Error("scenario failed");
				},
				async () => {
					throw new Error("cleanup failed");
				},
			),
		).rejects.toMatchObject({
			errors: [
				expect.objectContaining({ message: "scenario failed" }),
				expect.objectContaining({ message: "cleanup failed" }),
			],
		});
	});
	it("mutates the selected live child model and effort without changing main", async () => {
		await withHeadlessPi(async (agent) => {
			const { childRequest, mainAfterSpawn, spawned } = await spawnPendingHeadlessChild(agent, "Mutable child");
			await selectAndMutateHeadlessTarget(agent, mainAfterSpawn, spawned.id, "test_set_viewed_model");

			expect(agent.readSessionEntries(spawned.id)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "model_change", modelId: "headless-faux-reasoning" }),
					expect.objectContaining({ type: "thinking_level_change", thinkingLevel: "high" }),
				]),
			);
			expect(
				agent
					.readSessionEntries(null)
					.some((entry) => entry.type === "model_change" && entry.modelId === "headless-faux-reasoning"),
			).toBe(false);
			expect(
				agent
					.readSessionEntries(null)
					.some((entry) => entry.type === "thinking_level_change" && entry.thinkingLevel === "high"),
			).toBe(false);
			agent.respondToLlmRequest(childRequest.id, fauxAssistantMessage("Child complete"));
		});
	});

	it("rejects a completed selected target without mutating main", async () => {
		await withHeadlessPi(async (agent) => {
			const { childRequest, mainAfterSpawn, spawned } = await spawnPendingHeadlessChild(agent, "Completed target");
			agent.respondToLlmRequest(childRequest.id, fauxAssistantMessage("Completed"));
			await agent.waitForAgent((candidate) => candidate.id === spawned.id && candidate.lifecycle === "completed");

			const result = await selectAndMutateHeadlessTarget(agent, mainAfterSpawn, spawned.id, "test_set_viewed_model");
			expectFailedToolEntry(result, "not active");
			expect(
				agent
					.readSessionEntries(null)
					.some((entry) => entry.type === "model_change" && entry.modelId === "headless-faux-reasoning"),
			).toBe(false);
		});
	});

	it("rejects a nonexistent selected target without mutating main", async () => {
		await withHeadlessPi(async (agent) => {
			await agent.send({ type: "prompt", message: "Select a missing target" });
			const request = await agent.waitForLlmRequest((candidate) => candidate.agentId === null);
			const result = await selectAndMutateHeadlessTarget(agent, request, "agent_missing", "test_set_viewed_model");
			expectFailedToolEntry(result, "not found");
			expect(
				agent
					.readSessionEntries(null)
					.some((entry) => entry.type === "model_change" && entry.modelId === "headless-faux-reasoning"),
			).toBe(false);
		});
	});

	it("rejects a detached selected target without mutating main", async () => {
		await withHeadlessPi(async (agent) => {
			const { childRequest, mainAfterSpawn, spawned } = await spawnPendingHeadlessChild(
				agent,
				"Detached target",
				"background",
			);
			const result = await selectAndMutateHeadlessTarget(agent, mainAfterSpawn, spawned.id, "test_set_viewed_model");
			expectFailedToolEntry(result, "detached and not a live child session");
			expect(
				agent
					.readSessionEntries(null)
					.some((entry) => entry.type === "model_change" && entry.modelId === "headless-faux-reasoning"),
			).toBe(false);
			agent.respondToLlmRequest(childRequest.id, fauxAssistantMessage("Detached child complete"));
		});
	});

	it("spawns a child with its instructions and delivers completion to the main mailbox", async () => {
		await withHeadlessPi(async (agent) => {
			await agent.send({ type: "prompt", message: "Delegate the investigation" });

			const initialMainRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
			agent.respondToLlmRequest(
				initialMainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						displayName: "Investigator",
						prompt: "Inspect the authentication flow",
					}),
					{ stopReason: "toolUse" },
				),
			);

			const spawned = await agent.waitForAgent((candidate) => candidate.displayName === "Investigator");
			expect(spawned.lifecycle).toBe("running");

			const childRequest = await agent.waitForLlmRequest((request) => request.agentId === spawned.id);
			expect(childRequest.userMessages).toContain("Inspect the authentication flow");
			agent.respondToLlmRequest(childRequest.id, fauxAssistantMessage("Authentication flow inspected"));

			const mainAfterSpawn = await agent.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== initialMainRequest.id,
			);
			agent.respondToLlmRequest(mainAfterSpawn.id, fauxAssistantMessage("Worker started"));

			const completion = await agent.waitForMailboxMessage(
				(message) =>
					message.toAgentId === "main" && message.fromAgentId === spawned.id && message.status === "delivered",
			);
			expect(completion.body).toContain("Authentication flow inspected");
			expect(completion.status).toBe("delivered");

			const completionRequest = await agent.waitForLlmRequest(
				(request) =>
					request.agentId === null && JSON.stringify(request.messages).includes("Authentication flow inspected"),
			);
			agent.respondToLlmRequest(
				completionRequest.id,
				fauxAssistantMessage(fauxToolCall("list_agents", {}), { stopReason: "toolUse" }),
			);
			await agent.waitForSessionEntry(
				null,
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolName === "list_agents",
			);
			const postToolRequest = await agent.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== completionRequest.id,
			);
			agent.respondToLlmRequest(postToolRequest.id, fauxAssistantMessage("Completion handled after tool result"));
		});
	});

	it("wait_agents returns after an active subagent processes pending steering", async () => {
		await withHeadlessPi(async (agent) => {
			await agent.send({ type: "prompt", message: "Spawn a reviewer, then steer it" });
			const initialMainRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
			agent.respondToLlmRequest(
				initialMainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						displayName: "Steered reviewer",
						prompt: "Review the original implementation",
					}),
					{ stopReason: "toolUse" },
				),
			);

			const spawned = await agent.waitForAgent((candidate) => candidate.displayName === "Steered reviewer");
			const initialChildRequest = await agent.waitForLlmRequest((request) => request.agentId === spawned.id);
			const mainAfterSpawn = await agent.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== initialMainRequest.id,
			);
			agent.respondToLlmRequest(
				mainAfterSpawn.id,
				fauxAssistantMessage(
					fauxToolCall("steer_agent", {
						agentId: spawned.id,
						message: "Focus the review on cancellation races",
					}),
					{ stopReason: "toolUse" },
				),
			);

			await agent.waitForAgent(
				(candidate) => candidate.id === spawned.id && candidate.lifecycle === "steering_pending",
			);
			const mainAfterSteer = await agent.waitForLlmRequest(
				(request) =>
					request.agentId === null && request.id !== initialMainRequest.id && request.id !== mainAfterSpawn.id,
			);
			const waitToolCallId = "wait-for-steered-reviewer";
			agent.respondToLlmRequest(
				mainAfterSteer.id,
				fauxAssistantMessage({ ...fauxToolCall("wait_agents", {}), id: waitToolCallId }, { stopReason: "toolUse" }),
			);
			await agent.waitForEvent(
				(event) =>
					event.type === "tool_execution_start" &&
					event.toolName === "wait_agents" &&
					event.toolCallId === waitToolCallId,
			);

			agent.respondToLlmRequest(initialChildRequest.id, fauxAssistantMessage("Initial review complete"));
			const steeredChildRequest = await agent.waitForLlmRequest(
				(request) => request.agentId === spawned.id && request.id !== initialChildRequest.id,
			);
			expect(steeredChildRequest.userMessages).toContainEqual(
				expect.stringContaining("Focus the review on cancellation races"),
			);
			expect(
				agent
					.readSessionEntries(null)
					.some(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.toolCallId === waitToolCallId,
					),
			).toBe(false);

			agent.respondToLlmRequest(steeredChildRequest.id, fauxAssistantMessage("Cancellation races reviewed"));
			await agent.waitForAgent((candidate) => candidate.id === spawned.id && candidate.lifecycle === "completed");
			const mainAfterWait = await agent.waitForLlmRequest(
				(request) =>
					request.agentId === null &&
					request.id !== initialMainRequest.id &&
					request.id !== mainAfterSpawn.id &&
					request.id !== mainAfterSteer.id,
			);
			expect(JSON.stringify(mainAfterWait.messages)).toContain("Cancellation races reviewed");
			agent.respondToLlmRequest(mainAfterWait.id, fauxAssistantMessage("Steered reviewer completed"));
		});
	});

	it("wakes idle steering after completion of a real Pyrun tool turn", async () => {
		await withHeadlessPi(async (agent) => {
			await agent.send({ type: "prompt", message: "Run Pyrun, then finish the turn" });
			const initialRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
			agent.respondToLlmRequest(
				initialRequest.id,
				fauxAssistantMessage(fauxToolCall("pyrun_eval", { code: 'print("pyrun-race-complete")' }), {
					stopReason: "toolUse",
				}),
			);

			const postToolRequest = await agent.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== initialRequest.id,
			);
			expectSingleToolResult(postToolRequest, "pyrun-race-complete");
			agent.respondToLlmRequest(postToolRequest.id, fauxAssistantMessage("Pyrun turn complete"));
			await agent.waitForEvent((event) => event.type === "agent_end");

			await agent.send({ type: "steer", message: "Handle steering queued at the completion boundary" });
			const steeredRequest = await agent.waitForLlmRequest(
				(request) =>
					request.agentId === null && request.id !== initialRequest.id && request.id !== postToolRequest.id,
			);
			expect(steeredRequest.userMessages).toContain("Handle steering queued at the completion boundary");
			agent.respondToLlmRequest(steeredRequest.id, fauxAssistantMessage("Completion-boundary steering handled"));
		});
	});

	it("preserves queued steering when interrupting an active turn", async () => {
		await withHeadlessPi(async (agent) => {
			await agent.send({ type: "prompt", message: "Start a long response" });
			const interruptedRequest = await agent.waitForLlmRequest((request) => request.agentId === null);

			await agent.send({ type: "steer", message: "Preserve this steering after interrupt" });
			await agent.send({ type: "interrupt" });

			const resumedRequest = await agent.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== interruptedRequest.id,
			);
			expect(resumedRequest.userMessages).toContain("Preserve this steering after interrupt");
			agent.respondToLlmRequest(resumedRequest.id, fauxAssistantMessage("Steering preserved"));
		});
	});

	it("resumes a spawned agent that was thinking when its supervisor process died", async () => {
		await withHeadlessPi(async (agent) => {
			await agent.send({ type: "prompt", message: "Delegate work, then wait" });
			const mainRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
			agent.respondToLlmRequest(
				mainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						displayName: "Interrupted reviewer",
						prompt: "Review until the supervisor restarts",
					}),
					{ stopReason: "toolUse" },
				),
			);
			const spawned = await agent.waitForAgent((candidate) => candidate.displayName === "Interrupted reviewer");
			const originalTranscript = spawned.transcript;
			expect(originalTranscript?.path).toContain(originalTranscript?.sessionId);
			expect(existsSync(originalTranscript?.path ?? "")).toBe(true);
			const interruptedRequest = await agent.waitForLlmRequest((request) => request.agentId === spawned.id);

			await agent.crash();
			await agent.restart();

			const restoredRequest = await agent.waitForLlmRequest(
				(request) => request.agentId === spawned.id && request.id !== interruptedRequest.id,
			);
			const restoredMainRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
			agent.respondToLlmRequest(restoredMainRequest.id, fauxAssistantMessage("Supervisor resumed"));
			expect(restoredRequest.userMessages).toContain("Review until the supervisor restarts");
			expect(restoredRequest.userMessages).toContainEqual(expect.stringContaining("Continue the conversation"));
			expect(agent.listAgents().find((candidate) => candidate.id === spawned.id)?.transcript).toEqual(
				originalTranscript,
			);
			agent.respondToLlmRequest(restoredRequest.id, fauxAssistantMessage("Recovered review complete"));
			await expect(
				agent.waitForAgent((candidate) => candidate.id === spawned.id && candidate.lifecycle === "completed"),
			).resolves.toMatchObject({ id: spawned.id, lifecycle: "completed" });
			await agent.waitForMailboxMessage(
				(message) =>
					message.toAgentId === "main" && message.fromAgentId === spawned.id && message.status === "delivered",
			);
			expect(
				agent
					.listMailboxMessages()
					.filter((message) => message.toAgentId === "main" && message.fromAgentId === spawned.id),
			).toHaveLength(1);
		});
	});

	it("steers a restored child through the current main session after restart", async () => {
		await withHeadlessPi(async (agent) => {
			await agent.send({ type: "prompt", message: "Delegate work before restart" });
			const mainRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
			agent.respondToLlmRequest(
				mainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						displayName: "Restarted steering target",
						prompt: "Wait for steering after restart",
					}),
					{ stopReason: "toolUse" },
				),
			);
			const spawned = await agent.waitForAgent((candidate) => candidate.displayName === "Restarted steering target");
			const interruptedChildRequest = await agent.waitForLlmRequest((request) => request.agentId === spawned.id);

			await agent.crash();
			await agent.restart();

			const restoredChildRequest = await agent.waitForLlmRequest(
				(request) => request.agentId === spawned.id && request.id !== interruptedChildRequest.id,
			);
			const restoredMainRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
			agent.respondToLlmRequest(
				restoredMainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("steer_agent", {
						agentId: spawned.id,
						message: "Use the restored main session identity",
					}),
					{ stopReason: "toolUse" },
				),
			);
			await agent.waitForAgent(
				(candidate) => candidate.id === spawned.id && candidate.lifecycle === "steering_pending",
			);
			agent.respondToLlmRequest(restoredChildRequest.id, fauxAssistantMessage("Initial restored turn complete"));
			const steeredChildRequest = await agent.waitForLlmRequest(
				(request) => request.agentId === spawned.id && request.id !== restoredChildRequest.id,
			);
			expect(steeredChildRequest.userMessages).toContainEqual(
				expect.stringContaining("Use the restored main session identity"),
			);
			agent.respondToLlmRequest(steeredChildRequest.id, fauxAssistantMessage("Restored steering complete"));
		});
	});

	it("settles a dead detached Pyrun descendant when restoring its parent agent", async () => {
		await withHeadlessPi(
			async (agent) => {
				const attemptPath = join(agent.paths.workspaceDir, "attempts-child-dead-pyrun");
				const releasePath = join(agent.paths.workspaceDir, "release-child-dead-pyrun");
				await agent.send({ type: "prompt", message: "Delegate a detached evaluation" });
				const mainRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
				agent.respondToLlmRequest(
					mainRequest.id,
					fauxAssistantMessage(
						fauxToolCall("spawn_agent", {
							displayName: "Interrupted detached caller",
							prompt: "Run a detached Pyrun evaluation until release",
						}),
						{ stopReason: "toolUse" },
					),
				);
				const caller = await agent.waitForAgent(
					(candidate) => candidate.displayName === "Interrupted detached caller",
				);
				const callerRequest = await agent.waitForLlmRequest((request) => request.agentId === caller.id);
				const code = [
					"from pathlib import Path",
					"import time",
					`attempt = Path(${JSON.stringify(attemptPath)})`,
					`release = Path(${JSON.stringify(releasePath)})`,
					'attempt.write_text("started")',
					"while not release.exists(): time.sleep(0.05)",
				].join("\n");
				agent.respondToLlmRequest(
					callerRequest.id,
					fauxAssistantMessage(fauxToolCall("pyrun_eval", { code }), { stopReason: "toolUse" }),
				);
				await agent.waitForLlmRequest(
					(request) => request.agentId === caller.id && request.id !== callerRequest.id,
				);
				await waitForFileContent(attemptPath, "started");
				const detachedJob = await agent.waitForAgent(
					(candidate) => candidate.parentId === caller.id && candidate.displayName === "Pyrun evaluation",
				);
				const runnerPid = agent.getRunnerPid(detachedJob.id);
				if (!runnerPid) throw new Error("Child Pyrun runner has no PID");

				await agent.crash();
				killProcessGroup(runnerPid);
				await vi.waitFor(() => expect(() => process.kill(runnerPid, 0)).toThrow());
				await agent.restart();
				await agent.waitForLlmRequest(
					(request) => request.agentId === caller.id && request.id !== callerRequest.id,
				);

				await expect(
					agent.waitForAgent((candidate) => candidate.id === detachedJob.id && candidate.lifecycle === "failed"),
				).resolves.toMatchObject({
					error: { code: "lost_runtime" },
					id: detachedJob.id,
					lifecycle: "failed",
				});
			},
			{ autoDetachTools: true },
		);
	});

	it("persists detached tool state and terminal completion in the caller JSONL", async () => {
		await withHeadlessPi(
			async (agent) => {
				const releasePath = join(agent.paths.workspaceDir, "release-detached-jsonl");
				const toolCallId = "detached-jsonl-tool-call";
				const code = [
					"from pathlib import Path",
					"import time",
					`release = Path(${JSON.stringify(releasePath)})`,
					"while not release.exists(): time.sleep(0.05)",
					'print("detached-jsonl-complete")',
				].join("\n");
				await agent.send({ type: "prompt", message: "Detach this Pyrun evaluation" });
				const request = await agent.waitForLlmRequest((candidate) => candidate.agentId === null);
				agent.respondToLlmRequest(
					request.id,
					fauxAssistantMessage(
						{ ...fauxToolCall("pyrun_eval", { code }), id: toolCallId },
						{ stopReason: "toolUse" },
					),
				);

				const afterDetach = await agent.waitForLlmRequest(
					(candidate) => candidate.agentId === null && candidate.id !== request.id,
				);
				const detachedEntry = (await agent.waitForSessionEntry(
					null,
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === toolCallId,
				)) as SessionMessageEntry;
				expect(detachedEntry.message).toMatchObject({
					role: "toolResult",
					toolCallId,
					details: { type: "detached" },
				});
				const backgroundJobId = (detachedEntry.message as { details?: { backgroundJobId?: string } }).details
					?.backgroundJobId;
				expect(backgroundJobId).toBeTruthy();
				expect(
					agent
						.readSessionEntries(null)
						.some((entry) => entry.type === "custom" && entry.customType === "detached_tool_call_completion"),
				).toBe(false);
				const detachedJob = await agent.waitForAgent(
					(candidate) => candidate.id === backgroundJobId && candidate.lifecycle === "running",
				);
				agent.respondToLlmRequest(
					afterDetach.id,
					fauxAssistantMessage(fauxToolCall("wait_agents", {}), { stopReason: "toolUse" }),
				);
				await agent.waitForEvent(
					(event) => event.type === "tool_execution_start" && event.toolName === "wait_agents",
				);
				writeFileSync(releasePath, "release");
				await agent.waitForAgent(
					(candidate) => candidate.id === detachedJob.id && candidate.lifecycle === "completed",
				);
				expect(agent.listAgents().find((candidate) => candidate.id === detachedJob.id)?.result?.toolCallId).toBe(
					toolCallId,
				);
				await agent.waitForEvent(
					(event) => event.type === "tool_execution_end" && event.toolName === "wait_agents",
				);
				const completionRequest = await agent.waitForLlmRequest(
					(candidate) => candidate.agentId === null && JSON.stringify(candidate.messages).includes(detachedJob.id),
				);
				agent.respondToLlmRequest(completionRequest.id, fauxAssistantMessage("Detached completion recorded"));
				await agent.waitForMailboxMessage(
					(message) =>
						message.fromAgentId === detachedJob.id &&
						message.toAgentId === "main" &&
						message.status === "delivered",
				);
				const completionEntry = (await agent.waitForSessionEntry(
					null,
					(entry) => entry.type === "custom" && entry.customType === "detached_tool_call_completion",
				)) as CustomEntry;
				expect(completionEntry.data).toMatchObject({
					agentId: detachedJob.id,
					lifecycle: "completed",
					toolCallId,
				});
				const entries = agent.readSessionEntries(null);
				const completionEntries = entries.filter(
					(entry) => entry.type === "custom" && entry.customType === "detached_tool_call_completion",
				);
				expect(completionEntries).toHaveLength(1);
				const detachedIndex = entries.findIndex((entry) => entry.id === detachedEntry.id);
				const completionIndex = entries.findIndex((entry) => entry.id === completionEntry.id);
				expect(detachedIndex).toBeGreaterThanOrEqual(0);
				expect(completionIndex).toBeGreaterThan(detachedIndex);
			},
			{ autoDetachTools: true },
		);
	});

	it("routes a subagent detached completion only to the detached job parent", async () => {
		await withHeadlessPi(
			async (agent) => {
				const releasePath = join(agent.paths.workspaceDir, "release-subagent-detached");
				const toolCallId = "subagent-detached-tool-call";
				await agent.send({ type: "prompt", message: "Delegate a detached evaluation" });
				const mainRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
				agent.respondToLlmRequest(
					mainRequest.id,
					fauxAssistantMessage(
						fauxToolCall("spawn_agent", {
							displayName: "Detached caller",
							prompt: "Run the detached Pyrun evaluation",
						}),
						{ stopReason: "toolUse" },
					),
				);
				const caller = await agent.waitForAgent((candidate) => candidate.displayName === "Detached caller");
				const callerRequest = await agent.waitForLlmRequest((request) => request.agentId === caller.id);
				const code = [
					"from pathlib import Path",
					"import time",
					`release = Path(${JSON.stringify(releasePath)})`,
					"while not release.exists(): time.sleep(0.05)",
					'print("subagent-detached-complete")',
				].join("\n");
				agent.respondToLlmRequest(
					callerRequest.id,
					fauxAssistantMessage(
						{ ...fauxToolCall("pyrun_eval", { code }), id: toolCallId },
						{ stopReason: "toolUse" },
					),
				);
				const callerAfterDetach = await agent.waitForLlmRequest(
					(request) => request.agentId === caller.id && request.id !== callerRequest.id,
				);
				const childDetachedEntry = (await agent.waitForSessionEntry(
					caller.id,
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === toolCallId,
				)) as SessionMessageEntry;
				const childBackgroundJobId = (childDetachedEntry.message as { details?: { backgroundJobId?: string } })
					.details?.backgroundJobId;
				expect(childBackgroundJobId).toBeTruthy();
				const detachedJob = await agent.waitForAgent((candidate) => candidate.id === childBackgroundJobId);
				writeFileSync(releasePath, "release");
				await agent.waitForAgent(
					(candidate) => candidate.id === detachedJob.id && candidate.lifecycle === "completed",
				);
				const pendingCompletion = await agent.waitForMailboxMessage(
					(message) =>
						message.fromAgentId === detachedJob.id &&
						message.toAgentId === caller.id &&
						message.kind === "system" &&
						message.status === "pending",
				);
				expect(pendingCompletion.status).toBe("pending");
				expect(
					agent
						.listMailboxMessages()
						.some((message) => message.fromAgentId === detachedJob.id && message.toAgentId === "main"),
				).toBe(false);
				const runtimeMessages = agent
					.listRuntimeMailboxMessages()
					.filter((message) => message.sender.agentId === detachedJob.id);
				expect(runtimeMessages).toHaveLength(1);
				expect(runtimeMessages[0]?.recipient).toEqual({
					agentId: caller.id,
					sessionId: caller.transcript?.sessionId,
				});
				expect(runtimeMessages.some((message) => message.recipient.agentId === null)).toBe(false);

				agent.respondToLlmRequest(callerAfterDetach.id, fauxAssistantMessage("Detached child work started"));
				const completionRequest = await agent.waitForLlmRequest(
					(request) => request.agentId === caller.id && request.id !== callerAfterDetach.id,
				);
				expect(JSON.stringify(completionRequest.messages)).toContain(detachedJob.id);
				await agent.waitForMailboxMessage(
					(message) => message.id === pendingCompletion.id && message.status === "delivered",
				);
				await vi.waitFor(() => expect(agent.readTerminalOutboxStatuses(detachedJob.id)).toEqual(["delivered"]));
				const terminalRuntimeMessages = agent
					.listRuntimeMailboxMessages()
					.filter((message) => message.sender.agentId === detachedJob.id);
				expect(terminalRuntimeMessages).toHaveLength(1);
				expect(terminalRuntimeMessages[0]?.recipient).toEqual({
					agentId: caller.id,
					sessionId: caller.transcript?.sessionId,
				});

				const completionEntry = (await agent.waitForSessionEntry(
					caller.id,
					(entry) => entry.type === "custom" && entry.customType === "detached_tool_call_completion",
				)) as CustomEntry;
				expect(completionEntry.data).toMatchObject({
					agentId: detachedJob.id,
					lifecycle: "completed",
					toolCallId,
				});
				const callerCompletionEntries = agent
					.readSessionEntries(caller.id)
					.filter((entry) => entry.type === "custom" && entry.customType === "detached_tool_call_completion");
				expect(callerCompletionEntries).toHaveLength(1);
				expect(
					agent
						.readSessionEntries(null)
						.some(
							(entry) =>
								entry.type === "custom" &&
								entry.customType === "detached_tool_call_completion" &&
								JSON.stringify(entry.data).includes(detachedJob.id),
						),
				).toBe(false);

				agent.respondToLlmRequest(completionRequest.id, fauxAssistantMessage("Detached child work complete"));
			},
			{ autoDetachTools: true },
		);
	});

	it("continues post-tool model thinking after restoring the session JSONL", async () => {
		await withHeadlessPi(async (agent) => {
			await agent.send({ type: "prompt", message: "Run the command, then summarize it" });
			const initialRequest = await agent.waitForLlmRequest();
			agent.respondToLlmRequest(
				initialRequest.id,
				fauxAssistantMessage(fauxToolCall("bash", { command: "printf headless-tool-result" }), {
					stopReason: "toolUse",
				}),
			);
			const interruptedRequest = await agent.waitForLlmRequest(
				(request) => request.id !== initialRequest.id && request.agentId === null,
			);

			await agent.restart();

			const restoredRequest = await agent.waitForLlmRequest(
				(request) => request.id !== interruptedRequest.id && request.agentId === null,
			);
			expect(restoredRequest.messages.some((message) => message.role === "toolResult")).toBe(true);
			agent.respondToLlmRequest(restoredRequest.id, fauxAssistantMessage("Restored summary"));
			await expect(agent.waitForEvent((event) => event.type === "agent_end")).resolves.toMatchObject({
				type: "agent_end",
			});
		});
	});

	it("does not rerun a failed Bash tool when restoring its session", async () => {
		await withHeadlessPi(async (agent) => {
			const attemptPath = join(agent.paths.workspaceDir, "attempts-failed-bash");
			await agent.send({ type: "prompt", message: "Run the failing command, then explain it" });
			const initialRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
			agent.respondToLlmRequest(
				initialRequest.id,
				fauxAssistantMessage(
					fauxToolCall("bash", { command: `printf x >> '${attemptPath}'; printf failed-output; exit 7` }),
					{ stopReason: "toolUse" },
				),
			);
			const interruptedRequest = await agent.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== initialRequest.id,
			);
			expectSingleToolResult(interruptedRequest, "failed-output");
			expect(readFileSync(attemptPath, "utf8")).toBe("x");

			await agent.restart();

			const restoredRequest = await agent.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== interruptedRequest.id,
			);
			expectSingleToolResult(restoredRequest, "failed-output");
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(readFileSync(attemptPath, "utf8")).toBe("x");
			expect(
				agent
					.listAgents()
					.filter((candidate) => candidate.displayName === "Bash command" && candidate.lifecycle === "running"),
			).toHaveLength(0);
			agent.respondToLlmRequest(restoredRequest.id, fauxAssistantMessage("Failure explained"));
			await agent.waitForEvent((event) => event.type === "agent_end");
		});
	});

	it("does not rerun a failed Pyrun tool when restoring its session", async () => {
		await withHeadlessPi(async (agent) => {
			const attemptPath = join(agent.paths.workspaceDir, "attempts-failed-pyrun");
			const code = [
				"from pathlib import Path",
				`attempt = Path(${JSON.stringify(attemptPath)})`,
				`attempt.write_text((attempt.read_text() if attempt.exists() else "") + "x")`,
				'print("failed-pyrun-output")',
				'raise RuntimeError("failed-pyrun")',
			].join("\n");
			await agent.send({ type: "prompt", message: "Run the failing Pyrun evaluation, then explain it" });
			const initialRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
			agent.respondToLlmRequest(
				initialRequest.id,
				fauxAssistantMessage(fauxToolCall("pyrun_eval", { code }), { stopReason: "toolUse" }),
			);
			const interruptedRequest = await agent.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== initialRequest.id,
			);
			expectSingleFailedToolResult(interruptedRequest, "failed-pyrun-output");
			expect(readFileSync(attemptPath, "utf8")).toBe("x");

			await agent.restart();

			const restoredRequest = await agent.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== interruptedRequest.id,
			);
			expectSingleFailedToolResult(restoredRequest, "failed-pyrun-output");
			expect(readFileSync(attemptPath, "utf8")).toBe("x");
			expect(
				agent
					.listAgents()
					.filter(
						(candidate) => candidate.displayName === "Pyrun evaluation" && candidate.lifecycle === "running",
					),
			).toHaveLength(0);
			agent.respondToLlmRequest(restoredRequest.id, fauxAssistantMessage("Pyrun failure explained"));
			await agent.waitForEvent((event) => event.type === "agent_end");
		});
	});

	it("does not resume a cancelling Bash tool when restoring its session", async () => {
		await withHeadlessPi(async (agent) => {
			const attemptPath = join(agent.paths.workspaceDir, "attempts-cancelling-bash");
			const releasePath = join(agent.paths.workspaceDir, "release-cancelling-bash");
			await agent.send({ type: "prompt", message: "Run the cancellable command" });
			const initialRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
			agent.respondToLlmRequest(
				initialRequest.id,
				fauxAssistantMessage(
					fauxToolCall("bash", {
						command: `printf x >> '${attemptPath}'; while [ ! -f '${releasePath}' ]; do sleep 0.05; done`,
					}),
					{ stopReason: "toolUse" },
				),
			);
			await agent.waitForEvent((event) => event.type === "tool_execution_start");
			await vi.waitFor(() => expect(readFileSync(attemptPath, "utf8")).toBe("x"));
			const runner = await agent.waitForAgent(
				(candidate) => candidate.displayName === "Bash command" && candidate.lifecycle === "running",
			);

			const abort = agent.send({ type: "abort" });
			await agent.waitForAgent((candidate) => candidate.id === runner.id && candidate.lifecycle === "cancelling");
			await agent.crash();
			await abort.catch(() => undefined);
			await agent.restart();

			const settledRunner = await agent.waitForAgent(
				(candidate) =>
					candidate.id === runner.id && (candidate.lifecycle === "aborted" || candidate.lifecycle === "failed"),
			);
			expect(settledRunner.lifecycle).toBe("aborted");
			await agent.waitForEvent((event) => event.type === "tool_execution_end" && event.toolName === "bash");
			expect(readFileSync(attemptPath, "utf8")).toBe("x");
			expect(
				agent
					.listAgents()
					.filter((candidate) => candidate.displayName === "Bash command" && candidate.lifecycle === "running"),
			).toHaveLength(0);
		});
	});

	it("reconciles a cancelling Pyrun tool when another session starts", async () => {
		await withHeadlessPi(
			async (agent) => {
				const attemptPath = join(agent.paths.workspaceDir, "attempts-cancelling-pyrun");
				const releasePath = join(agent.paths.workspaceDir, "release-cancelling-pyrun");
				const code = [
					"from pathlib import Path",
					"import time",
					`attempt = Path(${JSON.stringify(attemptPath)})`,
					`release = Path(${JSON.stringify(releasePath)})`,
					`attempt.write_text((attempt.read_text() if attempt.exists() else "") + "x")`,
					"while not release.exists(): time.sleep(0.05)",
				].join("\n");
				await agent.send({ type: "prompt", message: "Run the cancellable Pyrun evaluation" });
				const initialRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
				agent.respondToLlmRequest(
					initialRequest.id,
					fauxAssistantMessage(fauxToolCall("pyrun_eval", { code }), { stopReason: "toolUse" }),
				);
				const afterDetach = await agent.waitForLlmRequest(
					(request) => request.agentId === null && request.id !== initialRequest.id,
				);
				const runner = await agent.waitForAgent(
					(candidate) => candidate.displayName === "Pyrun evaluation" && candidate.lifecycle === "running",
				);
				await vi.waitFor(() => expect(readFileSync(attemptPath, "utf8")).toBe("x"));
				const [runnerPid] = agent.getPyrunRunnerPids();
				if (!runnerPid) throw new Error("Pyrun runner has no PID");
				killProcessGroup(runnerPid);
				await vi.waitFor(() => expect(() => process.kill(runnerPid, 0)).toThrow());
				agent.respondToLlmRequest(
					afterDetach.id,
					fauxAssistantMessage(fauxToolCall("cancel_agent", { agentId: runner.id, reason: "test cancellation" }), {
						stopReason: "toolUse",
					}),
				);
				await agent.waitForAgent((candidate) => candidate.id === runner.id && candidate.lifecycle === "cancelling");
				const ownership = readMultiAgentRuntimeOwnership(
					getControlDbPath(agent.paths.agentDir),
					agent.sessionFile,
					runner.id,
				);
				const ownerSessionId = ownership?.owner.sessionId;
				if (!ownerSessionId) throw new Error("Pyrun runner has no owner session ID");

				await agent.crash();
				const [firstPeer, secondPeer] = await Promise.all([agent.startSharedSession(), agent.startSharedSession()]);
				try {
					expect(firstPeer.sessionId).not.toBe(ownerSessionId);
					expect(secondPeer.sessionId).not.toBe(ownerSessionId);
					expect(secondPeer.sessionId).not.toBe(firstPeer.sessionId);
					await agent.waitForAgent((candidate) => candidate.id === runner.id && candidate.lifecycle === "aborted");
					expect(readFileSync(attemptPath, "utf8")).toBe("x");
					expect(
						agent
							.listAgents()
							.filter((candidate) => candidate.id !== runner.id && candidate.displayName === "Pyrun evaluation"),
					).toHaveLength(0);
					expect(agent.getPyrunRunnerPids().filter(isProcessAlive)).toHaveLength(0);
					expect(agent.readTerminalOutboxStatuses(runner.id)).toHaveLength(1);
					expect(
						readMultiAgentRuntimeOwnership(getControlDbPath(agent.paths.agentDir), agent.sessionFile, runner.id)
							?.processIdentity,
					).toBeUndefined();
				} finally {
					await Promise.all([firstPeer.dispose(), secondPeer.dispose()]);
				}
			},
			{ autoDetachTools: true },
		);
	});

	it("lets same-session recovery win after listener registration blocks a foreign sweep", async () => {
		await withHeadlessPi(
			async (agent) => {
				const attemptPath = join(agent.paths.workspaceDir, "attempts-paused-resume-pyrun");
				const releaseRunnerPath = join(agent.paths.workspaceDir, "release-paused-resume-pyrun");
				const sessionStartReleasePath = join(agent.paths.workspaceDir, "release-paused-session-start");
				const code = [
					"from pathlib import Path",
					"import time",
					`attempt = Path(${JSON.stringify(attemptPath)})`,
					`release = Path(${JSON.stringify(releaseRunnerPath)})`,
					`attempt.write_text((attempt.read_text() if attempt.exists() else "") + "x")`,
					"while not release.exists(): time.sleep(0.05)",
				].join("\n");
				await agent.send({ type: "prompt", message: "Run the paused-resume Pyrun evaluation" });
				const initialRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
				agent.respondToLlmRequest(
					initialRequest.id,
					fauxAssistantMessage(fauxToolCall("pyrun_eval", { code }), { stopReason: "toolUse" }),
				);
				const afterDetach = await agent.waitForLlmRequest(
					(request) => request.agentId === null && request.id !== initialRequest.id,
				);
				const runner = await agent.waitForAgent(
					(candidate) => candidate.displayName === "Pyrun evaluation" && candidate.lifecycle === "running",
				);
				await vi.waitFor(() => expect(readFileSync(attemptPath, "utf8")).toBe("x"));
				const [runnerPid] = agent.getPyrunRunnerPids();
				if (!runnerPid) throw new Error("Pyrun runner has no PID");
				killProcessGroup(runnerPid);
				await vi.waitFor(() => expect(() => process.kill(runnerPid, 0)).toThrow());
				agent.respondToLlmRequest(
					afterDetach.id,
					fauxAssistantMessage(fauxToolCall("cancel_agent", { agentId: runner.id, reason: "test cancellation" }), {
						stopReason: "toolUse",
					}),
				);
				await agent.waitForAgent((candidate) => candidate.id === runner.id && candidate.lifecycle === "cancelling");
				await agent.crash();

				const resumePromise = agent.startSharedSession({
					sessionFile: agent.sessionFile,
					sessionStartReleasePath,
				});
				await waitForFileContent(`${sessionStartReleasePath}.ready`, "ready");
				const foreign = await agent.startSharedSession();
				try {
					expect(agent.listAgents().find((candidate) => candidate.id === runner.id)?.lifecycle).toBe("cancelling");
					writeFileSync(sessionStartReleasePath, "release");
					const resumed = await resumePromise;
					try {
						await agent.waitForAgent(
							(candidate) => candidate.id === runner.id && candidate.lifecycle === "aborted",
						);
						expect(agent.readTerminalOutboxStatuses(runner.id)).toHaveLength(1);
					} finally {
						await resumed.dispose();
					}
				} finally {
					writeFileSync(sessionStartReleasePath, "release");
					await foreign.dispose();
					await resumePromise.then((session) => session.dispose()).catch(() => undefined);
				}
			},
			{ autoDetachTools: true },
		);
	});

	it("reattaches a live Bash runner when restoring its unfinished JSONL tool call", async () => {
		await withHeadlessPi(async (agent) => {
			const attemptPath = join(agent.paths.workspaceDir, "attempts-bash");
			const releasePath = join(agent.paths.workspaceDir, "release-bash");
			await agent.send({ type: "prompt", message: "Wait for the release marker" });
			const initialRequest = await agent.waitForLlmRequest();
			agent.respondToLlmRequest(
				initialRequest.id,
				fauxAssistantMessage(
					fauxToolCall("bash", {
						command: `printf x >> '${attemptPath}'; while [ ! -f '${releasePath}' ]; do sleep 0.05; done; printf live-runner-output`,
					}),
					{ stopReason: "toolUse" },
				),
			);
			await agent.waitForEvent((event) => event.type === "tool_execution_start");
			const originalRunner = await agent.waitForAgent((candidate) => candidate.lifecycle === "running");
			await vi.waitFor(() => expect(readFileSync(attemptPath, "utf8")).toBe("x"));
			const originalPid = agent.getRunnerPid(originalRunner.id);
			if (!originalPid) throw new Error(`Bash runner has no PID: ${JSON.stringify(originalRunner)}`);

			await agent.crash();
			expect(() => process.kill(originalPid, 0)).not.toThrow();
			await agent.restart();
			await agent.waitForEvent((event) => event.type === "tool_execution_start");
			expect(readFileSync(attemptPath, "utf8")).toBe("x");

			const activeBashRunners = agent
				.listAgents()
				.filter((candidate) => candidate.displayName === "Bash command" && candidate.lifecycle === "running");
			expect(activeBashRunners.map((candidate) => candidate.id)).toEqual([originalRunner.id]);

			writeFileSync(releasePath, "release");
			const restoredRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
			expectSingleToolResult(restoredRequest, "live-runner-output");
			agent.respondToLlmRequest(restoredRequest.id, fauxAssistantMessage("Live runner restored"));
			await agent.waitForEvent((event) => event.type === "agent_end");
		});
	});

	it("reattaches a live Pyrun runner when restoring its unfinished JSONL tool call", async () => {
		await withHeadlessPi(async (agent) => {
			const attemptPath = join(agent.paths.workspaceDir, "attempts-pyrun");
			const releasePath = join(agent.paths.workspaceDir, "release-pyrun");
			const code = [
				"from pathlib import Path",
				"import time",
				`attempt = Path(${JSON.stringify(attemptPath)})`,
				`release = Path(${JSON.stringify(releasePath)})`,
				`attempt.write_text((attempt.read_text() if attempt.exists() else "") + "x")`,
				"while not release.exists(): time.sleep(0.05)",
				'print("live-pyrun-output")',
			].join("\n");
			await agent.send({ type: "prompt", message: "Wait in Pyrun for the release marker" });
			const initialRequest = await agent.waitForLlmRequest();
			agent.respondToLlmRequest(
				initialRequest.id,
				fauxAssistantMessage(fauxToolCall("pyrun_eval", { code }), { stopReason: "toolUse" }),
			);
			await agent.waitForEvent((event) => event.type === "tool_execution_start");
			await Promise.race([
				waitForFileContent(attemptPath, "x"),
				agent
					.waitForLlmRequest((request) => request.id !== initialRequest.id)
					.then((request) => {
						throw new Error(`Pyrun ended before execution: ${JSON.stringify(request.messages)}`);
					}),
			]);

			await agent.crash();
			await agent.restart();
			await agent.waitForEvent((event) => event.type === "tool_execution_start");
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(readFileSync(attemptPath, "utf8")).toBe("x");

			writeFileSync(releasePath, "release");
			const restoredRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
			expectSingleToolResult(restoredRequest, "live-pyrun-output");
			agent.respondToLlmRequest(restoredRequest.id, fauxAssistantMessage("Live Pyrun restored"));
			await agent.waitForEvent((event) => event.type === "agent_end");
		});
	});

	it("reruns an unfinished Pyrun JSONL tool call when its original runner is dead", async () => {
		await withHeadlessPi(async (agent) => {
			const attemptPath = join(agent.paths.workspaceDir, "attempts-dead-pyrun");
			const releasePath = join(agent.paths.workspaceDir, "release-dead-pyrun");
			const code = [
				"from pathlib import Path",
				"import time",
				`attempt = Path(${JSON.stringify(attemptPath)})`,
				`release = Path(${JSON.stringify(releasePath)})`,
				`attempt.write_text((attempt.read_text() if attempt.exists() else "") + "x")`,
				"while not release.exists(): time.sleep(0.05)",
				'print("rerun-pyrun-output")',
			].join("\n");
			await agent.send({ type: "prompt", message: "Wait in Pyrun for the release marker" });
			const initialRequest = await agent.waitForLlmRequest();
			agent.respondToLlmRequest(
				initialRequest.id,
				fauxAssistantMessage(fauxToolCall("pyrun_eval", { code }), { stopReason: "toolUse" }),
			);
			await agent.waitForEvent((event) => event.type === "tool_execution_start");
			await waitForFileContent(attemptPath, "x");
			const [originalPid] = agent.getPyrunRunnerPids();
			if (!originalPid) throw new Error("Pyrun runner has no PID");

			await agent.crash();
			killProcessGroup(originalPid);
			await vi.waitFor(() => expect(() => process.kill(originalPid, 0)).toThrow());
			await agent.restart();
			await agent.waitForEvent((event) => event.type === "tool_execution_start");
			await waitForFileContent(attemptPath, "xx");
			const replacementPids = agent.getPyrunRunnerPids().filter((pid) => pid !== originalPid);
			expect(replacementPids).toHaveLength(1);

			writeFileSync(releasePath, "release");
			const restoredRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
			expectSingleToolResult(restoredRequest, "rerun-pyrun-output");
			agent.respondToLlmRequest(restoredRequest.id, fauxAssistantMessage("Dead Pyrun rerun"));
			await agent.waitForEvent((event) => event.type === "agent_end");
		});
	});

	it("reruns an unfinished Bash JSONL tool call when its original runner is dead", async () => {
		await withHeadlessPi(async (agent) => {
			const attemptPath = join(agent.paths.workspaceDir, "attempts-dead-bash");
			const releasePath = join(agent.paths.workspaceDir, "release-dead-bash");
			await agent.send({ type: "prompt", message: "Wait for the release marker" });
			const initialRequest = await agent.waitForLlmRequest();
			agent.respondToLlmRequest(
				initialRequest.id,
				fauxAssistantMessage(
					fauxToolCall("bash", {
						command: `printf x >> '${attemptPath}'; while [ ! -f '${releasePath}' ]; do sleep 0.05; done; printf rerun-output`,
					}),
					{ stopReason: "toolUse" },
				),
			);
			await agent.waitForEvent((event) => event.type === "tool_execution_start");
			const originalRunner = await agent.waitForAgent((candidate) => candidate.lifecycle === "running");
			await vi.waitFor(() => expect(readFileSync(attemptPath, "utf8")).toBe("x"));
			const originalPid = agent.getRunnerPid(originalRunner.id);
			if (!originalPid) throw new Error(`Bash runner has no PID: ${JSON.stringify(originalRunner)}`);

			await agent.crash();
			killProcessGroup(originalPid);
			await vi.waitFor(() => expect(() => process.kill(originalPid, 0)).toThrow());
			await agent.restart();
			await agent.waitForEvent((event) => event.type === "tool_execution_start");
			const replacementRunner = await agent.waitForAgent(
				(candidate) => candidate.id !== originalRunner.id && candidate.lifecycle === "running",
			);
			expect(agent.getRunnerPid(replacementRunner.id)).not.toBe(originalPid);
			await vi.waitFor(() => expect(readFileSync(attemptPath, "utf8")).toBe("xx"));

			writeFileSync(releasePath, "release");
			const restoredRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
			expectSingleToolResult(restoredRequest, "rerun-output");
			agent.respondToLlmRequest(restoredRequest.id, fauxAssistantMessage("Dead runner rerun"));
			await agent.waitForEvent((event) => event.type === "agent_end");
		});
	});

	it("waits for production RPC events and removes files after success", async () => {
		let tempDir = "";
		await withHeadlessPi(async (agent) => {
			tempDir = agent.paths.tempDir;
			await agent.send({ type: "prompt", message: "Reply briefly" });
			const request = await agent.waitForLlmRequest();
			await expect(agent.waitForEvent((event) => event.type === "agent_start")).resolves.toMatchObject({
				type: "agent_start",
			});
			agent.respondToLlmRequest(request.id, fauxAssistantMessage("Done"));
		});
		expect(existsSync(tempDir)).toBe(false);
	});

	it("rejects pending waiters when the fixture disposes", async () => {
		let pendingAssertions: Promise<void>[] = [];
		await expect(
			withHeadlessPi(async (agent) => {
				const pendingWaiters = [
					agent.waitForEvent(() => false),
					agent.waitForLlmRequest(() => false),
					agent.waitForAgent(() => false),
					agent.waitForMailboxMessage(() => false),
				];
				pendingAssertions = pendingWaiters.map(async (waiter) => {
					await expect(waiter).rejects.toThrow("Headless Pi fixture disposed");
				});
				throw new Error("stop scenario");
			}),
		).rejects.toThrow("stop scenario");
		await Promise.all(pendingAssertions);
	});

	it("rejects new waiters immediately after disposal", async () => {
		let disposedAgent: HeadlessPi | undefined;
		await withHeadlessPi(async (agent) => {
			disposedAgent = agent;
		});
		if (!disposedAgent) throw new Error("expected disposed fixture handle");

		const waiters = [
			disposedAgent.waitForEvent(() => false),
			disposedAgent.waitForLlmRequest(() => false),
			disposedAgent.waitForAgent(() => false),
			disposedAgent.waitForMailboxMessage(() => false),
		];
		await Promise.all(
			waiters.map(async (waiter) => {
				const result = Promise.race([
					waiter,
					new Promise((_, reject) => setTimeout(() => reject(new Error("waiter did not reject")), 100)),
				]);
				await expect(result).rejects.toThrow("Headless Pi fixture disposed");
			}),
		);
	});

	it("uses isolated paths and removes files when the test body fails", async () => {
		let tempDir = "";
		await expect(
			withHeadlessPi(async (agent) => {
				tempDir = agent.paths.tempDir;
				const isolatedPaths = Object.values(agent.paths);
				expect(new Set(isolatedPaths).size).toBe(4);
				expect(isolatedPaths.every((path) => path === tempDir || path.startsWith(`${tempDir}/`))).toBe(true);
				throw new Error("scenario failed");
			}),
		).rejects.toThrow("scenario failed");
		expect(tempDir).not.toBe("");
		expect(existsSync(tempDir)).toBe(false);
	});
});
