import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import {
	type HeadlessLlmRequest,
	type HeadlessPi,
	type HeadlessPiOptions,
	requireHeadlessAgentSessionId,
	withHeadlessPi,
} from "../headless-pi.ts";

const REQUEST_WAIT_MS = 3_000;
const QUIET_WINDOW_MS = 1_000;
const options: HeadlessPiOptions = {
	cliPath: join(import.meta.dirname, "..", "fixtures", "thinking-timeout-cli.ts"),
};

function completedResponse(text: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })], {
		stopReason: "toolUse",
	});
}

function readAbortedRequestIds(agent: HeadlessPi): string[] {
	const path = join(agent.paths.workspaceDir, "provider-aborts.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => (JSON.parse(line) as { requestId: string }).requestId);
}

async function waitForProviderAbort(agent: HeadlessPi, request: HeadlessLlmRequest): Promise<void> {
	await expect.poll(() => readAbortedRequestIds(agent), { timeout: REQUEST_WAIT_MS }).toContain(request.id);
}

function isAssistantText(entry: SessionEntry, text: string): boolean {
	if (entry.type !== "message" || entry.message.role !== "assistant") return false;
	return entry.message.content.some((part) => part.type === "text" && part.text === text);
}

function countUserInput(agent: HeadlessPi, text: string, agentId: string | null = null): number {
	return agent.readSessionEntries(agentId).filter((entry) => {
		if (entry.type !== "message" || entry.message.role !== "user") return false;
		if (typeof entry.message.content === "string") return entry.message.content === text;
		return entry.message.content.some((part) => part.type === "text" && part.text === text);
	}).length;
}

async function expectNoRequest(agent: HeadlessPi, agentId: string | null = null): Promise<void> {
	await expect(agent.waitForLlmRequest((request) => request.agentId === agentId, QUIET_WINDOW_MS)).rejects.toThrow(
		"Timed out waiting for LLM request",
	);
}

async function expectIdle(agent: HeadlessPi): Promise<void> {
	const state = await agent.send({ type: "get_state" });
	expect(state).toMatchObject({ success: true, data: { isStreaming: false } });
}

async function finishRequest(agent: HeadlessPi, request: HeadlessLlmRequest, text: string): Promise<void> {
	agent.respondToLlmRequest(request.id, completedResponse(text));
	await agent.waitForSessionEntry(request.agentId, (entry) => isAssistantText(entry, text));
}

describe("thinking timeout automatic continuation (real process)", () => {
	it("aborts the held provider request, retries once, and persists the original session's final response", async () => {
		await withHeadlessPi(async (agent) => {
			const identity = { sessionId: agent.sessionId, sessionFile: agent.sessionFile };
			const prompt = "Finish the watchdog continuation regression";
			await agent.send({ type: "prompt", message: prompt });
			const initial = await agent.waitForLlmRequest();
			await waitForProviderAbort(agent, initial);
			const retry = await agent.waitForLlmRequest(undefined, REQUEST_WAIT_MS);
			expect(retry.id).not.toBe(initial.id);
			expect(retry.sessionId).toBe(identity.sessionId);
			expect(retry.userMessages.filter((message) => message === prompt)).toHaveLength(1);
			await finishRequest(agent, retry, "Automatic continuation completed");
			await expectNoRequest(agent);
			await expectIdle(agent);
			expect({ sessionId: agent.sessionId, sessionFile: agent.sessionFile }).toEqual(identity);
			expect(countUserInput(agent, prompt)).toBe(1);
		}, options);
	});

	it("stops after the second real timeout, reports failure, and accepts a fresh explicit prompt", async () => {
		await withHeadlessPi(async (agent) => {
			await agent.send({ type: "prompt", message: "Hold both watchdog attempts" });
			const initial = await agent.waitForLlmRequest();
			await waitForProviderAbort(agent, initial);
			const retry = await agent.waitForLlmRequest(undefined, REQUEST_WAIT_MS);
			await waitForProviderAbort(agent, retry);
			const failure = await agent.waitForEvent((event) => event.type === "auto_retry_end" && !event.success);
			expect(failure).toMatchObject({
				type: "auto_retry_end",
				attempt: 1,
				success: false,
				finalError: expect.stringContaining("thinking phase exceeded"),
			});
			await expectNoRequest(agent);
			await expectIdle(agent);
			expect(readAbortedRequestIds(agent)).toEqual([initial.id, retry.id]);
			await agent.send({ type: "prompt", message: "Fresh explicit request after exhausted watchdog" });
			const fresh = await agent.waitForLlmRequest();
			await finishRequest(agent, fresh, "Fresh request completed");
			await expectNoRequest(agent);
			await expectIdle(agent);
		}, options);
	});

	it("manual cancellation of the initial held request does not retry", async () => {
		await withHeadlessPi(async (agent) => {
			await agent.send({ type: "prompt", message: "Cancel before any watchdog recovery" });
			const initial = await agent.waitForLlmRequest();
			await agent.send({ type: "abort" });
			await waitForProviderAbort(agent, initial);
			await expectNoRequest(agent);
			await expectIdle(agent);
			expect(readAbortedRequestIds(agent)).toEqual([initial.id]);
		}, options);
	});

	it("manual cancellation of the automatic attempt does not start a third request", async () => {
		await withHeadlessPi(async (agent) => {
			await agent.send({ type: "prompt", message: "Cancel the automatic watchdog attempt" });
			const initial = await agent.waitForLlmRequest();
			await waitForProviderAbort(agent, initial);
			const retry = await agent.waitForLlmRequest(undefined, REQUEST_WAIT_MS);
			await agent.send({ type: "abort" });
			await waitForProviderAbort(agent, retry);
			await expectNoRequest(agent);
			await expectIdle(agent);
			expect(readAbortedRequestIds(agent)).toEqual([initial.id, retry.id]);
		}, options);
	});

	it("delivers queued user input once before the timeout replacement request", async () => {
		await withHeadlessPi(async (agent) => {
			const queuedInput = "Queued user input must precede stale watchdog work";
			await agent.send({ type: "prompt", message: "Hold while user input is queued" });
			const initial = await agent.waitForLlmRequest();
			await agent.send({ type: "follow_up", message: queuedInput });
			await waitForProviderAbort(agent, initial);
			const replacement = await agent.waitForLlmRequest(undefined, REQUEST_WAIT_MS);
			expect(replacement.userMessages.at(-1)).toBe(queuedInput);
			expect(replacement.userMessages.filter((message) => message === queuedInput)).toHaveLength(1);
			await finishRequest(agent, replacement, "Queued input handled");
			await expectNoRequest(agent);
			await expectIdle(agent);
			expect(countUserInput(agent, queuedInput)).toBe(1);
		}, options);
	});

	it("keeps a restored child's dispatch live through watchdog recovery and routes completion once", async () => {
		await withHeadlessPi(
			async (agent) => {
				const assignment = "Preserve this assignment through restart and watchdog recovery";
				await agent.send({ type: "prompt", message: "Delegate the restart watchdog regression" });
				const mainRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
				agent.respondToLlmRequest(
					mainRequest.id,
					fauxAssistantMessage(
						fauxToolCall("spawn_agent", {
							context: "fresh",
							displayName: "Watchdog restart child",
							prompt: assignment,
						}),
						{ stopReason: "toolUse" },
					),
				);
				const spawned = await agent.waitForAgent((candidate) => candidate.displayName === "Watchdog restart child");
				const childSessionId = requireHeadlessAgentSessionId(spawned);
				const originalTranscript = spawned.transcript;
				await agent.waitForLlmRequest((request) => request.sessionId === childSessionId);
				await agent.crash();
				await agent.restart();
				const restored = await agent.waitForLlmRequest((request) => request.sessionId === childSessionId);
				const restoredMain = await agent.waitForLlmRequest((request) => request.agentId === null);
				agent.respondToLlmRequest(restoredMain.id, completedResponse("Supervisor restored"));
				await waitForProviderAbort(agent, restored);
				const retry = await agent.waitForLlmRequest(
					(request) => request.sessionId === childSessionId,
					REQUEST_WAIT_MS,
				);
				expect(retry.userMessages).toContain(assignment);
				expect(retry.sessionId).toBe(childSessionId);
				expect(agent.listAgents().find((candidate) => candidate.id === spawned.id)).toMatchObject({
					id: spawned.id,
					parentId: spawned.parentId,
					lifecycle: "running",
					transcript: originalTranscript,
				});
				expect(agent.readTerminalOutboxStatuses(spawned.id)).toEqual([]);
				expect(agent.listMailboxMessages().filter((message) => message.fromAgentId === spawned.id)).toHaveLength(0);
				await finishRequest(agent, retry, "Recovered child completed");
				await agent.waitForAgent((candidate) => candidate.id === spawned.id && candidate.lifecycle === "completed");
				await agent.waitForMailboxMessage(
					(message) =>
						message.fromAgentId === spawned.id && message.toAgentId === "main" && message.status === "delivered",
				);
				await expectNoRequest(agent, spawned.id);
				expect(countUserInput(agent, assignment, spawned.id)).toBe(1);
				expect(agent.readTerminalOutboxStatuses(spawned.id)).toHaveLength(1);
				expect(agent.listMailboxMessages().filter((message) => message.fromAgentId === spawned.id)).toHaveLength(1);
			},
			{ ...options, env: { PI_HEADLESS_THINKING_DEADLINE_MS: "2500" } },
		);
	});
});
