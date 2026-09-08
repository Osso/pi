import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import agentsCoreExtension from "../../extensions/agents-core/src/index.ts";
import { MultiAgentStore } from "../../src/core/multi-agent-store.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const MINUTE = 60_000;
const REQUEST_START = Date.parse("2026-09-08T12:00:00.000Z");

describe("wait_agent request-relative deadline", () => {
	let harness: Harness | undefined;
	let finishChild: (() => void) | undefined;
	let prompt: Promise<void> | undefined;
	let childSignal: AbortSignal | undefined;
	let childAborted = false;
	let store: MultiAgentStore;

	afterEach(async () => {
		finishChild?.();
		await harness?.session.abort();
		await prompt;
		harness?.cleanup();
		harness = undefined;
		prompt = undefined;
		finishChild = undefined;
		childSignal = undefined;
		childAborted = false;
		vi.useRealTimers();
	});

	async function startWait(elapsedBeforeWait: number, waitCount = 1) {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		vi.setSystemTime(REQUEST_START);
		store = new MultiAgentStore();
		let waitInvocations = 0;
		const waitStarted = Promise.withResolvers<void>();
		harness = await createHarness({
			persistedSession: true,
			multiAgentStore: store,
			extensionFactories: [
				(pi) => {
					agentsCoreExtension(pi, {
						store,
						createChildSession: async (input) => {
							childSignal = input.signal;
							return {
								abort: () => {
									childAborted = true;
								},
								messages: [fauxAssistantMessage("child finished")],
								prompt: () =>
									new Promise<void>((resolve) => {
										finishChild = resolve;
									}),
								transcript: { path: join(input.ctx.cwd, "child.jsonl"), sessionId: "deadline-child" },
							};
						},
					});
					pi.on("tool_execution_start", (event) => {
						if (event.toolName !== "wait_agent") return;
						waitInvocations++;
						waitStarted.resolve();
						if (waitInvocations === 1) vi.setSystemTime(Date.now() + elapsedBeforeWait);
					});
				},
			],
		});
		store.setPersistenceSessionManager(harness.sessionManager);
		await harness.session.bindExtensions({});
		harness.session.setActiveToolsByName(["spawn_agent", "wait_agent"]);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("spawn_agent", { prompt: "Keep working", context: "fresh" })], {
				stopReason: "toolUse",
			}),
			...Array.from({ length: waitCount }, () =>
				fauxAssistantMessage([fauxToolCall("wait_agent", {})], { stopReason: "toolUse" }),
			),
			fauxAssistantMessage("supervisor done"),
		]);
		prompt = harness.session.prompt("Spawn a child and wait.");
		await waitStarted.promise;
		await vi.advanceTimersByTimeAsync(0);
		expect(waitInvocations).toBeGreaterThanOrEqual(1);
		expect(store.listActiveAgents()).toHaveLength(1);
		return harness;
	}

	function waitResults() {
		return harness?.eventsOfType("tool_execution_end").filter((event) => event.toolName === "wait_agent") ?? [];
	}

	function expectTimeout() {
		const event = waitResults().at(-1);
		expect(event).toMatchObject({ isError: false, result: { details: { timedOut: true } } });
		expect(getMessageText(event?.result)).toContain("agents are still running");
		expect(store.listAgents()).toMatchObject([{ lifecycle: "running" }]);
		expect(childSignal?.aborted).toBe(false);
		expect(childAborted).toBe(false);
	}

	it("counts elapsed model and tool time before wait instead of granting a new 25 minutes", async () => {
		await startWait(20 * MINUTE);
		await vi.advanceTimersByTimeAsync(5 * MINUTE - 1);
		expect(waitResults()).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(waitResults()).toHaveLength(1);
		expectTimeout();
	});

	it("returns immediately when the request deadline already expired without cancelling the child", async () => {
		await startWait(26 * MINUTE);
		expect(waitResults()).toHaveLength(1);
		expectTimeout();
	});

	it("bounds a full slice and lets the same child complete after timeout", async () => {
		await startWait(0);
		await vi.advanceTimersByTimeAsync(25 * MINUTE);
		expect(waitResults()).toHaveLength(1);
		expectTimeout();
		finishChild?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(store.listAgents()).toMatchObject([{ lifecycle: "completed", result: { summary: "child finished" } }]);
	});

	it("starts a new slice after the next model request and preserves completion delivery", async () => {
		await startWait(20 * MINUTE, 2);
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		expect(waitResults()).toHaveLength(1);
		expectTimeout();
		await vi.advanceTimersByTimeAsync(24 * MINUTE);
		expect(waitResults()).toHaveLength(1);
		finishChild?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(waitResults()).toHaveLength(2);
		const completion = waitResults()[1];
		expect(completion?.isError).toBe(false);
		expect(getMessageText(completion?.result)).toContain("child finished");
		expect(completion?.result.details).not.toHaveProperty("timedOut");
	});
});
