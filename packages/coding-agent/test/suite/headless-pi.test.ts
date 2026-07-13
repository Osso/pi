import { existsSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import {
	cleanupHeadlessPiResources,
	createHeadlessPaths,
	type HeadlessPi,
	runWithCleanup,
	withHeadlessPi,
} from "./headless-pi.ts";

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
