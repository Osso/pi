import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import {
	cleanupHeadlessPiResources,
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

function killProcessGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		process.kill(pid, "SIGKILL");
	}
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
		});
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
