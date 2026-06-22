import { describe, expect, it } from "vitest";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";

function spawnScout(store: MultiAgentStore) {
	return store.spawnAgent({
		agentType: "scout",
		cwd: "/repo",
		displayName: "Scout",
		parentId: "root",
		permission: { narrowed: true, policy: "on-request" },
	});
}

describe("MultiAgentStore", () => {
	it("rejects stale lifecycle mutations and returns the current snapshot", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const spawned = spawnScout(store);

		const started = store.transitionAgent(spawned.agent.id, spawned.agent.revision, "starting");
		expect(started.ok).toBe(true);

		const stale = store.transitionAgent(spawned.agent.id, spawned.agent.revision, "running");

		expect(stale).toMatchObject({
			ok: false,
			error: "stale_revision",
			current: {
				id: spawned.agent.id,
				lifecycle: "starting",
				revision: spawned.agent.revision + 1,
			},
		});
	});

	it("keeps view selection read-only", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const spawned = spawnScout(store);

		const viewed = store.selectAgentView(spawned.agent.id);
		const afterView = store.getAgent(spawned.agent.id);

		expect(viewed).toMatchObject({ id: spawned.agent.id, lifecycle: "queued", revision: spawned.agent.revision });
		expect(afterView).toEqual(viewed);
	});

	it("tracks steering messages through pending, accepted, and delivered acknowledgements", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const spawned = spawnScout(store);
		const started = store.transitionAgent(spawned.agent.id, spawned.agent.revision, "starting");
		expect(started.ok).toBe(true);
		if (!started.ok) {
			throw new Error("expected start to succeed");
		}
		const running = store.transitionAgent(spawned.agent.id, started.agent.revision, "running");
		expect(running.ok).toBe(true);
		if (!running.ok) {
			throw new Error("expected run to succeed");
		}

		const steer = store.sendSteering(spawned.agent.id, running.agent.revision, {
			body: "Inspect auth first",
			fromAgentId: "root",
			targetCheckpoint: "next_model_call",
		});

		expect(steer.ok).toBe(true);
		if (!steer.ok) {
			throw new Error("expected steering to succeed");
		}
		expect(steer.message).toMatchObject({
			body: "Inspect auth first",
			kind: "steer",
			status: "pending",
			targetCheckpoint: "next_model_call",
			toAgentId: spawned.agent.id,
		});
		expect(steer.agent.lifecycle).toBe("steering_pending");

		const accepted = store.ackSteering(spawned.agent.id, steer.agent.revision, steer.message.id, "accepted");
		expect(accepted.ok).toBe(true);
		if (!accepted.ok) {
			throw new Error("expected acceptance to succeed");
		}
		expect(accepted.message.status).toBe("accepted");
		expect(accepted.agent.lifecycle).toBe("steering_pending");

		const delivered = store.ackSteering(spawned.agent.id, accepted.agent.revision, steer.message.id, "delivered");
		expect(delivered.ok).toBe(true);
		if (!delivered.ok) {
			throw new Error("expected delivery to succeed");
		}
		expect(delivered.message.status).toBe("delivered");
		expect(delivered.agent.lifecycle).toBe("running");
	});

	it("derives active counts from core lifecycle state only", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const queued = spawnScout(store);
		const running = spawnScout(store);
		const completed = spawnScout(store);
		const failed = spawnScout(store);
		const aborted = spawnScout(store);

		const runningStart = store.transitionAgent(running.agent.id, running.agent.revision, "starting");
		expect(runningStart.ok).toBe(true);
		if (!runningStart.ok) {
			throw new Error("expected start to succeed");
		}
		const runningAgent = store.transitionAgent(running.agent.id, runningStart.agent.revision, "running");
		expect(runningAgent.ok).toBe(true);

		const completedStart = store.transitionAgent(completed.agent.id, completed.agent.revision, "starting");
		expect(completedStart.ok).toBe(true);
		if (!completedStart.ok) {
			throw new Error("expected completed start to succeed");
		}
		const completedRun = store.transitionAgent(completed.agent.id, completedStart.agent.revision, "running");
		expect(completedRun.ok).toBe(true);
		if (!completedRun.ok) {
			throw new Error("expected completed run to succeed");
		}
		expect(store.transitionAgent(completed.agent.id, completedRun.agent.revision, "completed").ok).toBe(true);

		expect(store.transitionAgent(failed.agent.id, failed.agent.revision, "aborted").ok).toBe(true);
		expect(store.transitionAgent(aborted.agent.id, aborted.agent.revision, "aborted").ok).toBe(true);

		expect(store.getActiveAgentCount()).toBe(2);
		expect(store.listActiveAgents().map((agent) => agent.id)).toEqual([queued.agent.id, running.agent.id]);
	});
});
