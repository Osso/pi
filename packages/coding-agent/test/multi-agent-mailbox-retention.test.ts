import { describe, expect, it } from "vitest";
import { type AgentMailboxMessage, type AgentSnapshot, MultiAgentStore } from "../src/core/multi-agent-store.ts";

const retentionMs = 24 * 60 * 60 * 1000;
const start = Date.parse("2026-10-08T12:00:00.000Z");

function agent(timestamp: number): AgentSnapshot {
	return {
		agentType: "implement",
		createdAt: new Date(timestamp).toISOString(),
		cwd: "/tmp",
		displayName: "Child",
		id: "agent_1",
		lifecycle: "running",
		parentId: undefined,
		permission: { narrowed: true, policy: "on-request" },
		revision: 1,
		updatedAt: new Date(timestamp).toISOString(),
	};
}

function message(
	status: AgentMailboxMessage["status"],
	createdAt = new Date(start).toISOString(),
): AgentMailboxMessage {
	return {
		body: "concrete steering payload",
		createdAt,
		fromAgentId: "main",
		id: `message_${status}`,
		kind: "steer",
		status,
		toAgentId: "agent_1",
		updatedAt: new Date(start + retentionMs - 1).toISOString(),
	};
}

describe("live multi-agent mailbox retention", () => {
	it("expires every status at creation age 24h, not update age, and preserves younger messages", () => {
		let now = start;
		const store = new MultiAgentStore({ now: () => new Date(now).toISOString() });
		const statuses: AgentMailboxMessage["status"][] = ["pending", "claimed", "accepted", "rejected", "failed"];
		for (const status of statuses) store.publishLifecycleCoordinatorSteering(agent(start), message(status));
		now = start + retentionMs - 1;
		expect(store.listMailboxMessages()).toHaveLength(statuses.length);
		const younger = store.recordOutboundSessionMessage({ fromAgentId: "main", toAgentId: "other", body: "keep" });
		now += 1;
		expect(store.listMailboxMessages()).toEqual([younger]);
		expect(store.getProjectionSnapshot().mailboxMessages).toEqual([younger]);
		expect(store.listPendingMailboxMessagesForAgent("agent_1")).toEqual([]);
		expect(store.markMailboxMessageDelivered("message_pending")).toBeUndefined();
		expect(store.markMailboxMessageFailed("message_pending", "late failure")).toBeUndefined();
	});

	it("does not reproject expired, missing, or invalid creation timestamps", () => {
		const now = start + retentionMs;
		const store = new MultiAgentStore({ now: () => new Date(now).toISOString() });
		for (const createdAt of [new Date(start).toISOString(), "", "not-a-date"]) {
			store.publishLifecycleCoordinatorSteering(agent(now), message("pending", createdAt));
		}
		expect(store.listMailboxMessages()).toEqual([]);
		expect(store.markMailboxMessageDelivered("message_pending")).toBeUndefined();
	});

	it("does not consume or replay an expired lifecycle notification", () => {
		let now = start;
		const store = new MultiAgentStore({ now: () => new Date(now).toISOString() });
		const emitted: AgentMailboxMessage[] = [];
		store.subscribeLifecycleNotifications((notice) => emitted.push(notice));
		const completed = { ...agent(start), lifecycle: "completed" as const, revision: 2, result: { summary: "done" } };
		store.publishTerminalOutboxSnapshot(completed);
		expect(emitted).toHaveLength(1);
		now += retentionMs;
		expect(store.listPendingLifecycleNotificationsForAgent("agent_1", "completed")).toEqual([]);
		expect(store.consumeCompletionNotificationsForAgent("agent_1")).toEqual([]);
		store.publishTerminalOutboxSnapshot(completed);
		expect(emitted).toHaveLength(1);
		expect(store.listMailboxMessages()).toEqual([]);
		expect(store.getAgent("agent_1")).toMatchObject({ lifecycle: "completed", revision: 2 });
	});
});
