import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import agentsCoreExtension from "../../extensions/agents-core/src/index.ts";
import {
	type ChildAgentDispatchInput,
	createMultiAgentRuntimeHandles,
} from "../../extensions/agents-core/src/runtime.ts";
import type { ExtensionAPI, ToolExecutionStartEvent } from "../../src/core/extensions/types.ts";
import { MultiAgentStore } from "../../src/core/multi-agent-store.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const MINUTE = 60_000;
const REQUEST_START = Date.parse("2026-09-08T12:00:00.000Z");

async function createChildRequestHarness(
	store: MultiAgentStore,
	runtimeHandles: ReturnType<typeof createMultiAgentRuntimeHandles>,
) {
	const childHarness = await createHarness({
		fauxProvider: { api: "deadline-child-api", provider: "deadline-child-provider" },
		multiAgentRuntimeRole: "child",
		multiAgentAgentId: store.listActiveAgents()[0].id,
		extensionFactories: [(pi) => agentsCoreExtension(pi, { store, runtimeHandles })],
	});
	await childHarness.session.bindExtensions({});
	childHarness.setResponses([
		fauxAssistantMessage([fauxToolCall("end_turn", { reason: "Child request complete" })], {
			stopReason: "toolUse",
		}),
	]);
	return childHarness;
}

describe("wait_agent request-relative deadline", () => {
	let harness: Harness | undefined;
	let finishChild: (() => void) | undefined;
	let prompt: Promise<void> | undefined;
	let childSignal: AbortSignal | undefined;
	let childAborted = false;
	let store: MultiAgentStore;
	let runtimeHandles = createMultiAgentRuntimeHandles();
	let childHarness: Harness | undefined;

	afterEach(async () => {
		finishChild?.();
		await harness?.session.abort();
		await prompt;
		childHarness?.cleanup();
		childHarness = undefined;
		harness?.cleanup();
		harness = undefined;
		prompt = undefined;
		finishChild = undefined;
		childSignal = undefined;
		childAborted = false;
		vi.useRealTimers();
	});

	function waitForChildCompletion() {
		return new Promise<void>((resolve) => {
			finishChild = resolve;
		});
	}

	async function createChildSession(input: ChildAgentDispatchInput) {
		childSignal = input.signal;
		return {
			abort: () => {
				childAborted = true;
			},
			messages: [fauxAssistantMessage("child finished")],
			prompt: waitForChildCompletion,
			transcript: { path: join(input.ctx.cwd, "child.jsonl"), sessionId: "deadline-child" },
		};
	}

	async function startWait(elapsedBeforeWait: number, waitCount = 1, beforeWait?: () => Promise<void>) {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		vi.setSystemTime(REQUEST_START);
		store = new MultiAgentStore();
		runtimeHandles = createMultiAgentRuntimeHandles();
		let waitInvocations = 0;
		let notifyWaitStarted: (() => void) | undefined;
		let rejectWaitStarted: ((error: unknown) => void) | undefined;
		const waitStarted = new Promise<void>((resolve, reject) => {
			notifyWaitStarted = resolve;
			rejectWaitStarted = reject;
		});
		const onToolExecutionStart = async (event: ToolExecutionStartEvent) => {
			if (event.toolName !== "wait_agent") return;
			waitInvocations++;
			if (waitInvocations !== 1) return;
			vi.setSystemTime(Date.now() + elapsedBeforeWait);
			try {
				await beforeWait?.();
				notifyWaitStarted?.();
			} catch (error) {
				rejectWaitStarted?.(error);
				throw error;
			}
		};
		const registerExtension = (pi: ExtensionAPI) => {
			agentsCoreExtension(pi, { store, runtimeHandles, createChildSession });
			pi.on("tool_execution_start", onToolExecutionStart);
		};
		harness = await createHarness({
			persistedSession: true,
			multiAgentStore: store,
			extensionFactories: [registerExtension],
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
		await waitStarted;
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

	it("expires on the next poll after suspend without cancelling the child", async () => {
		await startWait(20 * MINUTE);
		vi.setSystemTime(REQUEST_START + 26 * MINUTE);
		expect(waitResults()).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(waitResults()).toHaveLength(1);
		expectTimeout();
	});

	it("preserves completion before the first poll after suspend", async () => {
		await startWait(0);
		vi.setSystemTime(REQUEST_START + 26 * MINUTE);
		finishChild?.();
		await vi.advanceTimersByTimeAsync(3_000);
		expect(waitResults()).toHaveLength(1);
		const completion = waitResults()[0];
		expect(completion?.isError).toBe(false);
		expect(getMessageText(completion?.result)).toContain("child finished");
		expect(completion?.result.details).not.toHaveProperty("timedOut");
		expect(store.listAgents()).toMatchObject([{ lifecycle: "completed" }]);
		expect(childSignal?.aborted).toBe(false);
		expect(childAborted).toBe(false);
	});

	it("ignores a child model request before the parent starts waiting", async () => {
		await startWait(20 * MINUTE, 1, async () => {
			childHarness = await createChildRequestHarness(store, runtimeHandles);
			await childHarness.session.prompt("Continue child work");
			expect(childHarness.eventsOfType("model_request_start")).toHaveLength(1);
		});
		await vi.advanceTimersByTimeAsync(5 * MINUTE - 1);
		expect(waitResults()).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(Date.now()).toBe(REQUEST_START + 25 * MINUTE);
		expect(waitResults()).toHaveLength(1);
		expectTimeout();
	});

	it("expires the renewed slice exactly 25 minutes after the next model request", async () => {
		await startWait(20 * MINUTE, 2);
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		expect(waitResults()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(25 * MINUTE - 1);
		expect(waitResults()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(Date.now()).toBe(REQUEST_START + 50 * MINUTE);
		expect(waitResults()).toHaveLength(2);
		expectTimeout();
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
