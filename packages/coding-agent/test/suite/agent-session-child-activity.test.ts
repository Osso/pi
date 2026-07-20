import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import { type AgentCurrentActivity, MultiAgentStore } from "../../src/core/multi-agent-store.ts";
import { legacyMultiAgentStore } from "../helpers/legacy-multi-agent-store.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

interface AgentActivityPublisher {
	_publishCurrentAgentActivity(event: AgentEvent): void;
	_consumeThinkingPhaseTimeoutError(): Error | undefined;
	_runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void>;
}

const publishCurrentAgentActivity = (AgentSession.prototype as unknown as AgentActivityPublisher)
	._publishCurrentAgentActivity;

function spawnChild(store: MultiAgentStore): string {
	return legacyMultiAgentStore(store).spawnAgent({
		agentType: "test",
		cwd: "/repo",
		displayName: "Child",
		permission: { narrowed: true, policy: "on-request" },
	}).agent.id;
}

describe("child agent current activity", () => {
	afterEach(() => {
		vi.useRealTimers();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("preserves the next parallel tool's original activity when an earlier tool completes", async () => {
		const store = new MultiAgentStore({ now: () => "2026-07-13T12:00:00.000Z" });
		const agentId = spawnChild(store);
		const harness = await createHarness({ multiAgentAgentId: agentId, multiAgentStore: store });
		harnesses.push(harness);

		publishCurrentAgentActivity.call(harness.session, {
			type: "tool_execution_start",
			toolCallId: "tool-a",
			toolName: "read",
			args: { path: "A" },
			startedAt: 1_000,
		});
		publishCurrentAgentActivity.call(harness.session, {
			type: "tool_execution_start",
			toolCallId: "tool-b",
			toolName: "edit",
			args: { path: "B" },
			startedAt: 2_000,
		});
		publishCurrentAgentActivity.call(harness.session, {
			type: "tool_execution_end",
			toolCallId: "tool-a",
			toolName: "read",
			result: { content: [{ type: "text", text: "A done" }] },
			isError: false,
			startedAt: 1_000,
			finishedAt: 3_000,
		});

		expect(store.getAgent(agentId)?.currentActivity).toEqual({
			phase: "tool",
			startedAt: "1970-01-01T00:00:02.000Z",
			toolCallId: "tool-b",
			toolName: "edit",
		});

		publishCurrentAgentActivity.call(harness.session, {
			type: "tool_execution_end",
			toolCallId: "tool-b",
			toolName: "edit",
			result: { content: [{ type: "text", text: "B done" }] },
			isError: false,
			startedAt: 2_000,
			finishedAt: 4_000,
		});
		expect(store.getAgent(agentId)?.currentActivity).toEqual({
			phase: "thinking",
			startedAt: "1970-01-01T00:00:04.000Z",
		});
	});

	it("caps each main-session thinking phase while leaving tool execution uncapped", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({ thinkingPhaseTimeoutMs: 15 * 60 * 1000 });
		harnesses.push(harness);
		const abort = vi.spyOn(harness.session.agent, "abort");

		publishCurrentAgentActivity.call(harness.session, { type: "agent_start" });
		await vi.advanceTimersByTimeAsync(14 * 60 * 1000 + 59_000);
		expect(abort).not.toHaveBeenCalled();

		publishCurrentAgentActivity.call(harness.session, {
			type: "tool_execution_start",
			toolCallId: "long-tool",
			toolName: "read",
			args: { path: "large" },
			startedAt: Date.now(),
		});
		await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
		expect(abort).not.toHaveBeenCalled();

		publishCurrentAgentActivity.call(harness.session, {
			type: "tool_execution_end",
			toolCallId: "long-tool",
			toolName: "read",
			result: { content: [{ type: "text", text: "done" }] },
			isError: false,
			startedAt: Date.now() - 60 * 60 * 1000,
			finishedAt: Date.now(),
		});
		await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
		expect(abort).toHaveBeenCalledOnce();
	});

	it("caps each child thinking phase while leaving tool execution uncapped", async () => {
		vi.useFakeTimers();
		vi.setSystemTime("2026-07-13T12:00:00.000Z");
		const store = new MultiAgentStore({ now: () => new Date().toISOString() });
		const agentId = spawnChild(store);
		const harness = await createHarness({
			thinkingPhaseTimeoutMs: 15 * 60 * 1000,
			multiAgentAgentId: agentId,
			multiAgentStore: store,
		});
		harnesses.push(harness);
		const abort = vi.spyOn(harness.session.agent, "abort");

		publishCurrentAgentActivity.call(harness.session, { type: "agent_start" });
		await vi.advanceTimersByTimeAsync(14 * 60 * 1000 + 59_000);
		expect(abort).not.toHaveBeenCalled();

		publishCurrentAgentActivity.call(harness.session, {
			type: "tool_execution_start",
			toolCallId: "long-tool",
			toolName: "read",
			args: { path: "large" },
			startedAt: Date.now(),
		});
		await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
		expect(abort).not.toHaveBeenCalled();

		publishCurrentAgentActivity.call(harness.session, {
			type: "tool_execution_end",
			toolCallId: "long-tool",
			toolName: "read",
			result: { content: [{ type: "text", text: "done" }] },
			isError: false,
			startedAt: Date.now() - 60 * 60 * 1000,
			finishedAt: Date.now(),
		});
		await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
		expect(abort).toHaveBeenCalledOnce();
		expect(
			(AgentSession.prototype as unknown as AgentActivityPublisher)._consumeThinkingPhaseTimeoutError.call(
				harness.session,
			)?.message,
		).toBe("Child agent thinking phase exceeded 15 minutes");
	});

	it("resets and clears child thinking deadlines on steering, end, abort, and disposal", async () => {
		vi.useFakeTimers();
		const store = new MultiAgentStore();
		const agentId = spawnChild(store);
		const harness = await createHarness({
			thinkingPhaseTimeoutMs: 15 * 60 * 1000,
			multiAgentAgentId: agentId,
			multiAgentStore: store,
		});
		harnesses.push(harness);
		const abort = vi.spyOn(harness.session.agent, "abort");

		publishCurrentAgentActivity.call(harness.session, { type: "agent_start" });
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
		publishCurrentAgentActivity.call(harness.session, { type: "agent_start" });
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
		expect(abort).not.toHaveBeenCalled();

		publishCurrentAgentActivity.call(harness.session, {
			type: "agent_end",
			messages: [],
		});
		await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
		expect(abort).not.toHaveBeenCalled();

		publishCurrentAgentActivity.call(harness.session, { type: "agent_start" });
		await harness.session.abort();
		abort.mockClear();
		await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
		expect(abort).not.toHaveBeenCalled();

		publishCurrentAgentActivity.call(harness.session, { type: "agent_start" });
		harness.session.dispose();
		await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
		expect(abort).toHaveBeenCalledOnce();
	});

	it("clears the thinking deadline when a child run rejects without agent_end", async () => {
		vi.useFakeTimers();
		const store = new MultiAgentStore();
		const agentId = spawnChild(store);
		const harness = await createHarness({
			thinkingPhaseTimeoutMs: 15 * 60 * 1000,
			multiAgentAgentId: agentId,
			multiAgentStore: store,
		});
		harnesses.push(harness);
		const abort = vi.spyOn(harness.session.agent, "abort");
		publishCurrentAgentActivity.call(harness.session, { type: "agent_start" });
		vi.spyOn(harness.session.agent, "prompt").mockRejectedValue(new Error("provider failed"));
		await expect(
			(AgentSession.prototype as unknown as AgentActivityPublisher)._runAgentPrompt.call(harness.session, {
				role: "user",
				content: "work",
				timestamp: Date.now(),
			}),
		).rejects.toThrow("provider failed");
		abort.mockClear();
		await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
		expect(abort).not.toHaveBeenCalled();
	});

	it("publishes thinking and tool phases with stable start timestamps, then clears activity", async () => {
		vi.useFakeTimers();
		vi.setSystemTime("2026-07-13T12:00:00.000Z");
		const store = new MultiAgentStore({ now: () => new Date().toISOString() });
		const agentId = spawnChild(store);
		const observed: Array<AgentCurrentActivity | undefined> = [];
		store.subscribeAgentUpdates((_previous, current) => {
			if (current.id === agentId) observed.push(current.currentActivity);
		});
		const tool: AgentTool = {
			name: "inspect",
			label: "Inspect",
			description: "Inspect a target",
			parameters: Type.Object({ target: Type.String() }),
			execute: async () => {
				vi.setSystemTime("2026-07-13T12:00:05.000Z");
				return { content: [{ type: "text", text: "done" }], details: {} };
			},
		};
		const harness = await createHarness({ multiAgentAgentId: agentId, multiAgentStore: store, tools: [tool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("inspect", { target: "src" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("finished"),
		]);

		await harness.session.prompt("work");

		expect(observed).toEqual([
			{ phase: "thinking", startedAt: "2026-07-13T12:00:00.000Z" },
			{
				phase: "tool",
				startedAt: "2026-07-13T12:00:00.000Z",
				toolCallId: expect.any(String),
				toolName: "inspect",
			},
			{ phase: "thinking", startedAt: "2026-07-13T12:00:05.000Z" },
			undefined,
		]);
		expect(store.getAgent(agentId)?.currentActivity).toBeUndefined();
		const current = store.getAgent(agentId);
		if (!current) throw new Error("expected child agent");
		const completed = legacyMultiAgentStore(store).transitionAgent(agentId, current.revision, "completed");
		expect(completed.ok).toBe(true);
		expect(
			store.publishAgentCurrentActivity(agentId, {
				phase: "thinking",
				startedAt: "2026-07-13T12:00:06.000Z",
			}),
		).toBeUndefined();
		expect(store.getAgent(agentId)?.currentActivity).toBeUndefined();
	});
});
