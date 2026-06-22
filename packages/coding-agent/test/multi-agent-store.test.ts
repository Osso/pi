import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MULTI_AGENT_EVENT_CUSTOM_TYPE, MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { type CustomEntry, SessionManager } from "../src/core/session-manager.ts";

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

	it("preserves stable metadata and supports pinned slot updates without lifecycle changes", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const spawned = store.spawnAgent({
			account: { budgetId: "budget-1", id: "account-1" },
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			model: { modelId: "gpt-test", providerId: "faux", thinkingLevel: "medium" },
			parentId: "root",
			permission: { inheritedFrom: "root", narrowed: true, policy: "on-request" },
			slot: { index: 2, pinned: true },
			transcript: { path: "sessions/child.jsonl", sessionId: "session-1" },
			worktree: { base: "main", branch: "agent/worker", path: "/repo-worktrees/worker" },
		});

		const pinned = store.pinAgentSlot(spawned.agent.id, spawned.agent.revision, 7);

		expect(pinned.ok).toBe(true);
		if (!pinned.ok) {
			throw new Error("expected slot pin to succeed");
		}
		expect(pinned.agent).toMatchObject({
			account: { budgetId: "budget-1", id: "account-1" },
			cwd: "/repo",
			id: spawned.agent.id,
			lifecycle: "queued",
			model: { modelId: "gpt-test", providerId: "faux", thinkingLevel: "medium" },
			parentId: "root",
			permission: { inheritedFrom: "root", narrowed: true, policy: "on-request" },
			revision: spawned.agent.revision + 1,
			slot: { index: 7, pinned: true },
			transcript: { path: "sessions/child.jsonl", sessionId: "session-1" },
			worktree: { base: "main", branch: "agent/worker", path: "/repo-worktrees/worker" },
		});

		const cleared = store.clearAgentSlot(pinned.agent.id, pinned.agent.revision);
		expect(cleared.ok).toBe(true);
		if (!cleared.ok) {
			throw new Error("expected slot clear to succeed");
		}
		expect(cleared.agent).toMatchObject({
			id: spawned.agent.id,
			lifecycle: "queued",
			revision: pinned.agent.revision + 1,
		});
		expect(cleared.agent.slot).toBeUndefined();
	});

	it("covers explicit non-terminal lifecycle transitions through cancellation", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const spawned = spawnScout(store);

		const starting = store.transitionAgent(spawned.agent.id, spawned.agent.revision, "starting");
		expect(starting.ok).toBe(true);
		if (!starting.ok) {
			throw new Error("expected starting transition");
		}
		const running = store.transitionAgent(spawned.agent.id, starting.agent.revision, "running");
		expect(running.ok).toBe(true);
		if (!running.ok) {
			throw new Error("expected running transition");
		}
		const waiting = store.transitionAgent(spawned.agent.id, running.agent.revision, "waiting_for_input");
		expect(waiting.ok).toBe(true);
		if (!waiting.ok) {
			throw new Error("expected waiting transition");
		}
		const cancelling = store.transitionAgent(spawned.agent.id, waiting.agent.revision, "cancelling");
		expect(cancelling.ok).toBe(true);
		if (!cancelling.ok) {
			throw new Error("expected cancelling transition");
		}
		const aborted = store.transitionAgent(spawned.agent.id, cancelling.agent.revision, "aborted");

		expect(aborted).toMatchObject({
			ok: true,
			agent: {
				id: spawned.agent.id,
				lifecycle: "aborted",
				revision: spawned.agent.revision + 5,
			},
		});
	});

	it("lists descendants below a parent without leaking sibling branches", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const scout = spawnScout(store);
		const scoutChild = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Scout Child",
			parentId: scout.agent.id,
			permission: { narrowed: true, policy: "on-request" },
		});
		const sibling = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Sibling",
			parentId: "root",
			permission: { narrowed: true, policy: "on-request" },
		});

		expect(store.listDescendants("root").map((agent) => agent.id)).toEqual([
			scout.agent.id,
			scoutChild.agent.id,
			sibling.agent.id,
		]);
		expect(store.listDescendants(scout.agent.id).map((agent) => agent.id)).toEqual([scoutChild.agent.id]);
	});

	it("lets a child contact only its supervisor through the mailbox", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const supervisor = spawnScout(store);
		const child = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			parentId: supervisor.agent.id,
			permission: { narrowed: true, policy: "on-request" },
		});
		store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Sibling",
			parentId: "root",
			permission: { narrowed: true, policy: "on-request" },
		});

		const contact = store.contactSupervisor(child.agent.id, child.agent.revision, {
			body: "Need clarification on auth scope",
			artifactIds: ["artifact-1"],
		});

		expect(contact.ok).toBe(true);
		if (!contact.ok) {
			throw new Error("expected supervisor contact to succeed");
		}
		expect(contact.agent).toMatchObject({
			id: child.agent.id,
			lastActivity: { description: "Contacted supervisor" },
			revision: child.agent.revision + 1,
		});
		expect(contact.message).toMatchObject({
			artifactIds: ["artifact-1"],
			body: "Need clarification on auth scope",
			fromAgentId: child.agent.id,
			kind: "supervisor_request",
			status: "pending",
			toAgentId: supervisor.agent.id,
		});
	});

	it("stores mailbox artifact references by metadata without copying content", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const supervisor = spawnScout(store);
		const child = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			parentId: supervisor.agent.id,
			permission: { narrowed: true, policy: "on-request" },
		});

		const contact = store.contactSupervisor(child.agent.id, child.agent.revision, {
			artifactRefs: [
				{
					id: "diff-1",
					label: "Auth diff",
					path: "artifacts/auth.diff",
					content: "large diff content must not enter the mailbox",
				} as { content: string; id: string; label: string; path: string },
			],
			body: "Review attached diff",
		});

		expect(contact.ok).toBe(true);
		if (!contact.ok) {
			throw new Error("expected supervisor contact to succeed");
		}
		expect(contact.message.artifactRefs).toEqual([
			{
				id: "diff-1",
				label: "Auth diff",
				path: "artifacts/auth.diff",
			},
		]);
		expect(JSON.stringify(contact.message)).not.toContain("large diff content");
	});

	it("persists snapshots as SessionManager custom entries", () => {
		const session = SessionManager.inMemory("/repo");
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const spawned = spawnScout(store);
		const viewed = store.selectAgentView(spawned.agent.id);

		const entryId = store.persistSnapshot(session);

		const entry = session.getEntries().find((candidate) => candidate.id === entryId) as CustomEntry | undefined;
		expect(viewed?.id).toBe(spawned.agent.id);
		expect(entry).toMatchObject({
			customType: MULTI_AGENT_EVENT_CUSTOM_TYPE,
			data: {
				kind: "snapshot",
				selectedAgentId: spawned.agent.id,
				version: 1,
			},
		});
	});

	it("rehydrates the latest persisted snapshot after reopening a session", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-multi-agent-store-"));
		try {
			const session = SessionManager.create(tempDir, join(tempDir, "sessions"));
			session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
			session.appendMessage({
				api: "anthropic-messages",
				content: [{ text: "hi", type: "text" }],
				model: "test",
				provider: "anthropic",
				role: "assistant",
				stopReason: "stop",
				timestamp: 2,
				usage: {
					cacheRead: 0,
					cacheWrite: 0,
					cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
					input: 1,
					output: 1,
					totalTokens: 2,
				},
			});

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
				body: "Continue with tests",
				fromAgentId: "root",
				targetCheckpoint: "after_tool_result",
			});
			expect(steer.ok).toBe(true);
			store.persistSnapshot(session);

			const sessionFile = session.getSessionFile();
			if (!sessionFile) {
				throw new Error("expected persisted session file");
			}
			const reopenedSession = SessionManager.open(sessionFile);
			const rehydrated = MultiAgentStore.fromSessionManager(reopenedSession, {
				now: () => "2026-06-21T00:00:00.000Z",
			});

			expect(rehydrated.getAgent(spawned.agent.id)).toMatchObject({
				id: spawned.agent.id,
				lifecycle: "steering_pending",
				revision: 4,
			});
			expect(rehydrated.getActiveAgentCount()).toBe(1);
			expect(rehydrated.listMailboxMessages()).toHaveLength(1);
			expect(rehydrated.listMailboxMessages()[0]).toMatchObject({
				body: "Continue with tests",
				status: "pending",
				targetCheckpoint: "after_tool_result",
			});
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});
});
