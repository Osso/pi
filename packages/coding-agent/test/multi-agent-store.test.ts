import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { getControlDbPath, readMultiAgentState } from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const managedTempDirs: string[] = [];

afterAll(() => {
	for (const dir of managedTempDirs) {
		rmSync(dir, { force: true, recursive: true });
	}
});

function createControlDbSession(tempDir?: string, cwd = "/repo"): SessionManager {
	let dir = tempDir;
	if (!dir) {
		dir = mkdtempSync(join(tmpdir(), "pi-agent-store-db-"));
		managedTempDirs.push(dir);
	}
	const session = SessionManager.create(cwd, dir);
	session.setMetadataControlDbPath(getControlDbPath(dir));
	return session;
}

function spawnScout(store: MultiAgentStore) {
	return store.spawnAgent({
		agentType: "scout",
		cwd: "/repo",
		displayName: "Scout",
		parentId: "root",
		permission: { narrowed: true, policy: "on-request" },
	});
}

function completeAgent(store: MultiAgentStore, agent: { id: string; revision: number }) {
	const started = store.transitionAgent(agent.id, agent.revision, "starting");
	expect(started.ok).toBe(true);
	if (!started.ok) {
		throw new Error("expected start to succeed");
	}
	const running = store.transitionAgent(agent.id, started.agent.revision, "running");
	expect(running.ok).toBe(true);
	if (!running.ok) {
		throw new Error("expected run to succeed");
	}
	const completed = store.transitionAgent(agent.id, running.agent.revision, "completed");
	expect(completed.ok).toBe(true);
	if (!completed.ok) {
		throw new Error("expected terminal transition");
	}
	return completed.agent;
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

	it("notifies subscribers for lifecycle and transcript metadata updates", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const spawned = spawnScout(store);
		const updates: Array<[string, string | undefined]> = [];
		store.subscribeAgentUpdates((previous, current) => {
			updates.push([previous.lifecycle, current.transcript?.path]);
		});

		const started = store.transitionAgent(spawned.agent.id, spawned.agent.revision, "starting");
		expect(started.ok).toBe(true);
		const transcript = store.updateAgentTranscript(spawned.agent.id, {
			path: "/tmp/child-session.jsonl",
			sessionId: "child-session",
		});

		expect(transcript.ok).toBe(true);
		expect(updates).toEqual([
			["queued", undefined],
			["starting", "/tmp/child-session.jsonl"],
		]);
	});

	it("isolates throwing update subscribers from persisted terminal notifications", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-agent-update-listener-"));
		try {
			const session = createControlDbSession(tempDir);
			const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
			store.setPersistenceSessionManager(session);
			const spawned = spawnScout(store);
			const throwingUpdate = vi.fn(() => {
				throw new Error("update listener failed");
			});
			const otherUpdate = vi.fn();
			const transitions: Array<string | undefined> = [];
			const lifecycleNotifications: string[] = [];
			store.subscribeAgentUpdates(throwingUpdate);
			store.subscribeAgentUpdates(otherUpdate);
			store.subscribeAgentTransitions((_previous, current) => transitions.push(current.lifecycle));
			store.subscribeLifecycleNotifications((message) => {
				if (message.body !== undefined) {
					lifecycleNotifications.push(message.body);
				}
			});

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
			const completed = store.transitionAgent(spawned.agent.id, running.agent.revision, "completed");

			expect(completed).toMatchObject({ ok: true, agent: { lifecycle: "completed" } });
			expect(throwingUpdate).toHaveBeenCalledTimes(3);
			expect(otherUpdate).toHaveBeenCalledTimes(3);
			expect(transitions).toEqual(["starting", "running", "completed"]);
			expect(lifecycleNotifications).toEqual(["Scout completed."]);

			const controlDbPath = session.getMetadataControlDbPath();
			const sessionPath = session.getSessionFile();
			if (!controlDbPath || !sessionPath) {
				throw new Error("expected control DB session");
			}
			const state = readMultiAgentState(controlDbPath, sessionPath);
			expect(state?.agents).toMatchObject([{ id: spawned.agent.id, lifecycle: "completed" }]);
			expect(state?.mailboxMessages).toMatchObject([
				{ fromAgentId: spawned.agent.id, status: "pending", threadId: `agent-completed:${spawned.agent.id}` },
			]);
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("keeps view selection read-only", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const spawned = spawnScout(store);

		const viewed = store.selectAgentView(spawned.agent.id);
		const afterView = store.getAgent(spawned.agent.id);

		expect(viewed).toMatchObject({ id: spawned.agent.id, lifecycle: "queued", revision: spawned.agent.revision });
		expect(afterView).toEqual(viewed);
	});

	it("clears view selection without mutating agent lifecycle", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const spawned = spawnScout(store);

		store.selectAgentView(spawned.agent.id);
		store.clearSelectedAgentView();

		expect(store.getSelectedAgentId()).toBeUndefined();
		expect(store.getAgent(spawned.agent.id)).toMatchObject({ id: spawned.agent.id, lifecycle: "queued" });
	});

	it("selects inactive agents for read-only view", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const active = spawnScout(store);
		const completed = spawnScout(store);
		const started = store.transitionAgent(completed.agent.id, completed.agent.revision, "starting");
		expect(started.ok).toBe(true);
		if (!started.ok) {
			throw new Error("expected start to succeed");
		}
		const running = store.transitionAgent(completed.agent.id, started.agent.revision, "running");
		expect(running.ok).toBe(true);
		if (!running.ok) {
			throw new Error("expected run to succeed");
		}
		const terminal = store.transitionAgent(completed.agent.id, running.agent.revision, "completed");
		expect(terminal.ok).toBe(true);
		if (!terminal.ok) {
			throw new Error("expected terminal transition");
		}

		store.selectAgentView(active.agent.id);
		const selected = store.selectAgentView(completed.agent.id);

		expect(selected).toMatchObject({ id: completed.agent.id, lifecycle: "completed" });
		expect(store.getSelectedAgentId()).toBe(completed.agent.id);
	});

	it("rejects inactive agents for active targets without changing the selected view", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const active = spawnScout(store);
		const completed = spawnScout(store);
		const started = store.transitionAgent(completed.agent.id, completed.agent.revision, "starting");
		expect(started.ok).toBe(true);
		if (!started.ok) {
			throw new Error("expected start to succeed");
		}
		const running = store.transitionAgent(completed.agent.id, started.agent.revision, "running");
		expect(running.ok).toBe(true);
		if (!running.ok) {
			throw new Error("expected run to succeed");
		}
		const terminal = store.transitionAgent(completed.agent.id, running.agent.revision, "completed");
		expect(terminal.ok).toBe(true);
		if (!terminal.ok) {
			throw new Error("expected terminal transition");
		}

		store.selectAgentView(active.agent.id);
		const selected = store.selectActiveAgentTargetWithStatus(completed.agent.id);

		expect(selected).toMatchObject({ ok: false, error: "inactive", agent: { id: completed.agent.id } });
		expect(store.getSelectedAgentId()).toBe(active.agent.id);
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
			transcript: { path: "/tmp/sessions/child.jsonl", sessionId: "session-1" },
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
			transcript: { path: "/tmp/sessions/child.jsonl", sessionId: "session-1" },
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

	it("attaches saved sessions as child agents while preserving session identity", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const parent = store.spawnAgent({
			agentType: "lead",
			cwd: "/repo",
			displayName: "Lead",
			permission: { narrowed: true, policy: "on-request" },
		});

		const first = store.attachSessionAgent(parent.agent.id, {
			agentType: "resumed-session",
			cwd: "/repo",
			displayName: "Saved Work",
			permission: { inheritedFrom: parent.agent.id, narrowed: true, policy: "on-request" },
			transcript: { path: "/sessions/saved.jsonl", sessionId: "saved-session" },
		});
		const second = store.attachSessionAgent(parent.agent.id, {
			agentType: "resumed-session",
			cwd: "/repo",
			displayName: "Saved Work Again",
			permission: { inheritedFrom: parent.agent.id, narrowed: true, policy: "on-request" },
			transcript: { path: "/sessions/saved.jsonl", sessionId: "saved-session" },
		});
		const broadened = store.attachSessionAgent(parent.agent.id, {
			agentType: "resumed-session",
			cwd: "/repo",
			displayName: "Broad Saved Work",
			permission: { inheritedFrom: parent.agent.id, narrowed: false, policy: "auto-approve" },
			transcript: { path: "/sessions/saved.jsonl", sessionId: "saved-session" },
		});

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (!first.ok || !second.ok) {
			throw new Error("expected session attachments");
		}
		expect(first.agent).toMatchObject({
			agentType: "resumed-session",
			lifecycle: "waiting_for_input",
			parentId: parent.agent.id,
			permission: { inheritedFrom: parent.agent.id, narrowed: true, policy: "on-request" },
			transcript: { path: "/sessions/saved.jsonl", sessionId: "saved-session" },
		});
		expect(second.agent.id).not.toBe(first.agent.id);
		expect(second.agent.transcript?.sessionId).toBe("saved-session");
		expect(broadened).toMatchObject({ ok: false, error: "permission_broadened" });
	});

	it("spawns child agents with inherited account model budget and narrowed permission metadata", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const parent = store.spawnAgent({
			account: {
				budgetId: "budget-1",
				concurrencyCap: 2,
				id: "account-1",
				providerFallback: ["openai", "anthropic"],
				rateLimit: { perMinute: 30 },
				tokenBudget: { limit: 100_000 },
			},
			agentType: "lead",
			cwd: "/repo",
			displayName: "Lead",
			model: { modelId: "gpt-test", providerId: "openai", thinkingLevel: "medium" },
			permission: { narrowed: true, policy: "on-request" },
		});

		const child = store.spawnChildAgent(parent.agent.id, {
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			permission: { inheritedFrom: parent.agent.id, narrowed: true, policy: "on-request" },
		});
		const broadened = store.spawnChildAgent(parent.agent.id, {
			agentType: "worker",
			cwd: "/repo",
			displayName: "Broad Worker",
			permission: { inheritedFrom: parent.agent.id, narrowed: false, policy: "auto-approve" },
		});

		expect(child.ok).toBe(true);
		if (!child.ok) {
			throw new Error("expected inherited child spawn");
		}
		expect(child.agent).toMatchObject({
			account: parent.agent.account,
			model: parent.agent.model,
			parentId: parent.agent.id,
			permission: { inheritedFrom: parent.agent.id, narrowed: true, policy: "on-request" },
		});
		expect(broadened).toMatchObject({
			ok: false,
			error: "permission_broadened",
			parent: { id: parent.agent.id },
		});
	});

	it("keeps account metadata separate from mailbox workflow and UI selection state", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const spawned = store.spawnAgent({
			account: {
				id: "account-1",
				mailboxMessages: ["hidden message"],
				selectedAgentId: "agent_999",
				workflowState: { step: "hidden" },
			} as { id: string; mailboxMessages: string[]; selectedAgentId: string; workflowState: { step: string } },
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			permission: { narrowed: true, policy: "on-request" },
		});

		expect(spawned.agent.account).toEqual({ id: "account-1" });
		expect(JSON.stringify(spawned.agent.account)).not.toContain("hidden");
		expect(store.getProjectionSnapshot().selectedAgentId).toBeUndefined();
		expect(store.listMailboxMessages()).toEqual([]);
	});

	it("bounds terminal and subprocess workers by core permission mailbox and lifecycle contracts", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const supervisor = store.spawnAgent({
			agentType: "lead",
			cwd: "/repo",
			displayName: "Lead",
			permission: { narrowed: true, policy: "on-request" },
		});
		const terminalWorker = store.spawnChildAgent(supervisor.agent.id, {
			agentType: "terminal-pane-worker",
			cwd: "/repo",
			displayName: "Terminal Worker",
			permission: { inheritedFrom: supervisor.agent.id, narrowed: true, policy: "on-request" },
			worker: { adapter: "terminal", handleId: "pane-1" },
		});
		const broadenedWorker = store.spawnChildAgent(supervisor.agent.id, {
			agentType: "subprocess-worker",
			cwd: "/repo",
			displayName: "Broad Worker",
			permission: { inheritedFrom: supervisor.agent.id, narrowed: false, policy: "auto-approve" },
			worker: { adapter: "subprocess", handleId: "pid-1" },
		});
		const sibling = store.spawnAgent({
			agentType: "subprocess-worker",
			cwd: "/repo",
			displayName: "Sibling Worker",
			parentId: "root",
			permission: { narrowed: true, policy: "on-request" },
			worker: { adapter: "subprocess", handleId: "pid-2" },
		});

		expect(terminalWorker.ok).toBe(true);
		if (!terminalWorker.ok) {
			throw new Error("expected terminal worker spawn");
		}
		expect(terminalWorker.agent).toMatchObject({
			lifecycle: "queued",
			parentId: supervisor.agent.id,
			permission: { inheritedFrom: supervisor.agent.id, narrowed: true, policy: "on-request" },
			worker: { adapter: "terminal", handleId: "pane-1" },
		});
		expect(broadenedWorker).toMatchObject({ ok: false, error: "permission_broadened" });

		const siblingMessage = store.sendMailboxMessage(terminalWorker.agent.id, terminalWorker.agent.revision, {
			body: "hi sibling",
			toAgentId: sibling.agent.id,
		});
		expect(siblingMessage).toMatchObject({ ok: false, error: "forbidden_target" });

		const starting = store.transitionAgent(terminalWorker.agent.id, terminalWorker.agent.revision, "starting");
		expect(starting.ok).toBe(true);
		const staleRunning = store.transitionAgent(terminalWorker.agent.id, terminalWorker.agent.revision, "running");
		expect(staleRunning).toMatchObject({ ok: false, error: "stale_revision" });
	});

	it("restores persisted multi-agent state into an existing store instance", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-agent-existing-store-"));
		try {
			const session = createControlDbSession(tempDir);
			const persisted = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
			persisted.setPersistenceSessionManager(session);
			const spawned = persisted.spawnAgent({
				agentType: "worker",
				cwd: "/repo",
				displayName: "Recovered",
				permission: { narrowed: true, policy: "on-request" },
				slot: { index: 2, pinned: true },
			});
			persisted.selectAgentView(spawned.agent.id);

			const existing = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
			existing.restoreFromSessionManager(session);

			expect(existing.getAgent(spawned.agent.id)).toMatchObject({ displayName: "Recovered" });
			expect(existing.getProjectionSnapshot()).toMatchObject({
				slots: [{ agentId: spawned.agent.id, index: 2, pinned: true }],
			});
			expect(existing.getSelectedAgentId()).toBeUndefined();
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("starts branched sessions with an empty multi-agent store", () => {
		const session = createControlDbSession();
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		store.setPersistenceSessionManager(session);
		const spawned = spawnScout(store);
		const leafId = session.appendMessage({ role: "user", content: "branch point", timestamp: 1 });
		const originalSessionFile = session.getSessionFile();

		const branchedFile = session.createBranchedSession(leafId);
		store.restoreFromSessionManager(session);

		expect(branchedFile).toBeDefined();
		expect(branchedFile).not.toBe(originalSessionFile);
		expect(store.listAgents()).toEqual([]);
		expect(store.getAgent(spawned.agent.id)).toBeUndefined();
	});

	it("clears an existing store when the restored session has no persisted multi-agent state", () => {
		const session = SessionManager.inMemory("/repo");
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const spawned = spawnScout(store);
		store.selectAgentView(spawned.agent.id);

		store.restoreFromSessionManager(session);

		expect(store.listAgents()).toEqual([]);
		expect(store.getSelectedAgentId()).toBeUndefined();
	});

	it("clears runtime subscribers when restoring another session snapshot", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-agent-subscribers-"));
		try {
			const session = createControlDbSession(tempDir);
			const source = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
			source.setPersistenceSessionManager(session);
			const spawned = spawnScout(source);
			const stale = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
			const lifecycleNotified = vi.fn();
			const transitionNotified = vi.fn();
			stale.subscribeLifecycleNotifications(lifecycleNotified);
			stale.subscribeAgentTransitions(transitionNotified);

			stale.restoreFromSessionManager(session);
			const running = stale.transitionAgent(spawned.agent.id, spawned.agent.revision, "starting");
			expect(running.ok).toBe(true);

			expect(lifecycleNotified).not.toHaveBeenCalled();
			expect(transitionNotified).not.toHaveBeenCalled();
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("persists agent state automatically after multi-agent mutations", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-agent-auto-persist-"));
		try {
			const session = createControlDbSession(tempDir);
			const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
			store.setPersistenceSessionManager(session);

			const spawned = store.spawnAgent({
				agentType: "worker",
				cwd: "/repo",
				displayName: "Worker",
				permission: { narrowed: true, policy: "on-request" },
			});
			store.selectAgentView(spawned.agent.id);
			const transitioned = store.transitionAgent(spawned.agent.id, spawned.agent.revision, "starting");
			expect(transitioned.ok).toBe(true);

			const rehydrated = MultiAgentStore.fromSessionManager(session, {
				now: () => "2026-06-21T00:00:00.000Z",
			});

			expect(rehydrated.getAgent(spawned.agent.id)).toMatchObject({ lifecycle: "starting" });
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("persists bounded transcript and event stream metadata without inline output logs", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-multi-agent-"));
		try {
			const session = SessionManager.create(tempDir, join(tempDir, "sessions"));
			session.setMetadataControlDbPath(getControlDbPath(tempDir));
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
			store.setPersistenceSessionManager(session);
			const spawned = store.spawnAgent({
				agentType: "worker",
				cwd: "/repo",
				displayName: "Worker",
				eventStream: {
					eventCount: 50,
					inlineEvents: ["hidden child output"],
					path: join(tempDir, "agent-events.jsonl"),
					truncated: true,
				},
				parentId: "root",
				permission: { narrowed: true, policy: "on-request" },
				transcript: {
					inlineMessages: ["hidden transcript output"],
					path: join(tempDir, "agent-transcript.jsonl"),
					sessionId: "child-session",
				},
			} as Parameters<MultiAgentStore["spawnAgent"]>[0] & {
				eventStream: { eventCount: number; inlineEvents: string[]; path: string; truncated: boolean };
				transcript: { inlineMessages: string[]; path: string; sessionId: string };
			});

			const sessionFile = session.getSessionFile();
			if (!sessionFile) {
				throw new Error("expected persisted session file");
			}
			const reopenedSession = SessionManager.open(sessionFile);
			reopenedSession.setMetadataControlDbPath(getControlDbPath(tempDir));
			const rehydrated = MultiAgentStore.fromSessionManager(reopenedSession, {
				now: () => "2026-06-21T00:00:00.000Z",
			});
			const rehydratedAgent = rehydrated.getAgent(spawned.agent.id);

			expect(rehydratedAgent).toMatchObject({
				eventStream: {
					eventCount: 50,
					path: join(tempDir, "agent-events.jsonl"),
					truncated: true,
				},
				transcript: {
					path: join(tempDir, "agent-transcript.jsonl"),
					sessionId: "child-session",
				},
			});
			expect(JSON.stringify(rehydratedAgent)).not.toContain("hidden");
			expect(JSON.stringify(rehydrated.getProjectionSnapshot())).not.toContain("hidden");
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("projects authoritative snapshots for UI surfaces without sharing mutable state", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const first = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "First",
			parentId: "root",
			permission: { narrowed: true, policy: "on-request" },
			slot: { index: 1, pinned: true },
		});
		store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Second",
			parentId: "root",
			permission: { narrowed: true, policy: "on-request" },
		});
		store.selectAgentView(first.agent.id);

		const projection = store.getProjectionSnapshot();
		expect(projection).toMatchObject({
			activeCount: 2,
			selectedAgentId: first.agent.id,
			slots: [
				{
					agent: { id: first.agent.id, displayName: "First" },
					agentId: first.agent.id,
					index: 1,
					pinned: true,
					revision: first.agent.revision,
				},
			],
		});

		projection.agents[0].displayName = "mutated projection";
		if (projection.slots[0]) {
			projection.slots[0].agent.displayName = "mutated slot projection";
		}
		expect(store.getAgent(first.agent.id)?.displayName).toBe("First");
	});

	it("resyncs stale slot projections by agent ID from current core state", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const spawned = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			parentId: "root",
			permission: { narrowed: true, policy: "on-request" },
			slot: { index: 1, pinned: true },
		});
		const staleProjection = store.getProjectionSnapshot();

		const pinned = store.pinAgentSlot(spawned.agent.id, spawned.agent.revision, 4);
		expect(pinned.ok).toBe(true);
		if (!pinned.ok) {
			throw new Error("expected slot pin to succeed");
		}
		const currentProjection = store.getProjectionSnapshot();

		expect(staleProjection.slots).toMatchObject([{ agentId: spawned.agent.id, index: 1 }]);
		expect(currentProjection.slots).toMatchObject([
			{
				agent: { id: spawned.agent.id, revision: pinned.agent.revision },
				agentId: spawned.agent.id,
				index: 4,
				revision: pinned.agent.revision,
			},
		]);
	});

	it("projects TUI rows and stale slot conflicts from current core snapshots", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const spawned = store.spawnAgent({
			agentType: "terminal-pane-worker",
			cwd: "/repo",
			displayName: "Worker",
			parentId: "root",
			permission: { narrowed: true, policy: "on-request" },
			slot: { index: 1, pinned: true },
			worker: { adapter: "terminal", handleId: "pane-1" },
		});
		const staleProjection = store.getProjectionSnapshot();
		const starting = store.transitionAgent(spawned.agent.id, spawned.agent.revision, "starting");
		expect(starting.ok).toBe(true);
		if (!starting.ok) {
			throw new Error("expected starting transition");
		}
		const repinned = store.pinAgentSlot(spawned.agent.id, starting.agent.revision, 3);
		expect(repinned.ok).toBe(true);
		if (!repinned.ok) {
			throw new Error("expected slot repin");
		}

		const currentProjection = store.getProjectionSnapshot();
		const staleConflict = store.pinAgentSlot(spawned.agent.id, spawned.agent.revision, 9);

		expect(staleProjection.rows).toMatchObject([
			{
				agentId: spawned.agent.id,
				lifecycle: "queued",
				revision: spawned.agent.revision,
				slotIndex: 1,
				workerAdapter: "terminal",
			},
		]);
		expect(currentProjection.rows).toMatchObject([
			{
				agentId: spawned.agent.id,
				lifecycle: "starting",
				revision: repinned.agent.revision,
				slotIndex: 3,
				workerAdapter: "terminal",
			},
		]);
		expect(staleConflict).toMatchObject({
			ok: false,
			error: "stale_revision",
			current: { id: spawned.agent.id, revision: repinned.agent.revision },
			projection: {
				rows: [
					{
						agentId: spawned.agent.id,
						revision: repinned.agent.revision,
						slotIndex: 3,
					},
				],
			},
		});
	});

	it("clears selected view when the selected agent becomes terminal", () => {
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
		store.selectAgentView(spawned.agent.id);

		const completed = store.transitionAgent(spawned.agent.id, running.agent.revision, "completed");

		expect(completed.ok).toBe(true);
		expect(store.getSelectedAgentId()).toBeUndefined();
		expect(store.getAgent(spawned.agent.id)).toMatchObject({ lifecycle: "completed" });
	});

	it("maps slot fallback to active agent order", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const completed = spawnScout(store);
		const active = spawnScout(store);
		completeAgent(store, completed.agent);

		const selected = store.selectActiveAgentSlotTarget(1);

		expect(selected).toMatchObject({ id: active.agent.id, revision: active.agent.revision });
		expect(store.getSelectedAgentId()).toBe(active.agent.id);
	});

	it("switches pinned slots by index and falls back to agent row order", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const first = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "First",
			parentId: "root",
			permission: { narrowed: true, policy: "on-request" },
			slot: { index: 1, pinned: true },
		});
		const ninth = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Ninth",
			parentId: "root",
			permission: { narrowed: true, policy: "on-request" },
			slot: { index: 9, pinned: true },
		});
		const third = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Third",
			parentId: "root",
			permission: { narrowed: true, policy: "on-request" },
		});
		const started = store.transitionAgent(ninth.agent.id, ninth.agent.revision, "starting");
		expect(started.ok).toBe(true);
		if (!started.ok) {
			throw new Error("expected ninth start");
		}

		const selectedFirst = store.selectActiveAgentSlotTarget(1);
		const selectedNinth = store.selectActiveAgentSlotTarget(9);
		const selectedSecondRow = store.selectActiveAgentSlotTarget(2);
		const selectedThirdRow = store.selectActiveAgentSlotTarget(3);
		const missing = store.selectActiveAgentSlotTarget(4);

		expect(selectedFirst).toMatchObject({
			id: first.agent.id,
			lifecycle: "queued",
			revision: first.agent.revision,
		});
		expect(selectedNinth).toMatchObject({
			id: ninth.agent.id,
			lifecycle: "starting",
			revision: started.agent.revision,
		});
		expect(selectedSecondRow).toMatchObject({ id: ninth.agent.id, revision: started.agent.revision });
		expect(selectedThirdRow).toMatchObject({ id: third.agent.id, revision: third.agent.revision });
		expect(missing).toBeUndefined();
		expect(store.getSelectedAgentId()).toBe(third.agent.id);
		expect(store.getAgent(first.agent.id)).toMatchObject({ lifecycle: "queued", revision: first.agent.revision });
		expect(store.getAgent(ninth.agent.id)).toMatchObject({ lifecycle: "starting", revision: started.agent.revision });
	});

	it("keeps pinned slot bindings stable when another agent tries to claim the same slot", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const first = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "First",
			parentId: "root",
			permission: { narrowed: true, policy: "on-request" },
			slot: { index: 4, pinned: true },
		});
		const second = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Second",
			parentId: "root",
			permission: { narrowed: true, policy: "on-request" },
			slot: { index: 5, pinned: true },
		});
		const startedFirst = store.transitionAgent(first.agent.id, first.agent.revision, "starting");
		expect(startedFirst.ok).toBe(true);
		if (!startedFirst.ok) {
			throw new Error("expected first start");
		}

		const conflict = store.pinAgentSlot(second.agent.id, second.agent.revision, 4);

		expect(conflict).toMatchObject({
			ok: false,
			error: "slot_conflict",
			current: { id: second.agent.id, revision: second.agent.revision },
			occupant: { id: first.agent.id, revision: startedFirst.agent.revision },
			projection: {
				slots: [
					{ agentId: first.agent.id, index: 4, revision: startedFirst.agent.revision },
					{ agentId: second.agent.id, index: 5, revision: second.agent.revision },
				],
			},
		});
		expect(store.selectActiveAgentSlotTarget(4)).toMatchObject({
			id: first.agent.id,
			revision: startedFirst.agent.revision,
		});
		expect(store.selectActiveAgentSlotTarget(5)).toMatchObject({
			id: second.agent.id,
			revision: second.agent.revision,
		});
	});

	it("records a pending parent notification when an agent waits for input", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const parent = spawnScout(store);
		const child = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			parentId: parent.agent.id,
			permission: { narrowed: true, policy: "on-request" },
		});
		const starting = store.transitionAgent(child.agent.id, child.agent.revision, "starting");
		expect(starting.ok).toBe(true);
		if (!starting.ok) {
			throw new Error("expected starting transition");
		}
		const running = store.transitionAgent(child.agent.id, starting.agent.revision, "running");
		expect(running.ok).toBe(true);
		if (!running.ok) {
			throw new Error("expected running transition");
		}

		const waiting = store.transitionAgent(child.agent.id, running.agent.revision, "waiting_for_input");

		expect(waiting.ok).toBe(true);
		expect(store.listMailboxMessages()).toMatchObject([
			{
				body: "Worker is waiting for input.",
				fromAgentId: child.agent.id,
				kind: "system",
				status: "pending",
				threadId: `agent-waiting-for-input:${child.agent.id}`,
				toAgentId: parent.agent.id,
			},
		]);
		expect(store.listPendingMailboxMessagesForAgent(parent.agent.id)).toHaveLength(1);
	});

	it("does not duplicate pending waiting-for-input notifications for the same agent", () => {
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
		const firstWaiting = store.transitionAgent(spawned.agent.id, running.agent.revision, "waiting_for_input");
		expect(firstWaiting.ok).toBe(true);
		if (!firstWaiting.ok) {
			throw new Error("expected first waiting transition");
		}
		const rerun = store.transitionAgent(spawned.agent.id, firstWaiting.agent.revision, "running");
		expect(rerun.ok).toBe(true);
		if (!rerun.ok) {
			throw new Error("expected rerun transition");
		}

		const secondWaiting = store.transitionAgent(spawned.agent.id, rerun.agent.revision, "waiting_for_input");

		expect(secondWaiting.ok).toBe(true);
		expect(store.listMailboxMessages()).toHaveLength(1);
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
			body: "Need clarification on auth scope",
			fromAgentId: child.agent.id,
			kind: "supervisor_request",
			status: "pending",
			toAgentId: supervisor.agent.id,
		});
	});

	it("sends direct mailbox messages only across parent-child relationships", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const parent = spawnScout(store);
		const child = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Child",
			parentId: parent.agent.id,
			permission: { narrowed: true, policy: "on-request" },
		});
		const sibling = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Sibling",
			parentId: "root",
			permission: { narrowed: true, policy: "on-request" },
		});

		const sentToChild = store.sendMailboxMessage(parent.agent.id, parent.agent.revision, {
			body: "Please inspect auth",
			toAgentId: child.agent.id,
		});
		expect(sentToChild.ok).toBe(true);
		if (!sentToChild.ok) {
			throw new Error("expected parent-to-child message");
		}
		const siblingAttempt = store.sendMailboxMessage(child.agent.id, child.agent.revision, {
			body: "Can I read your state?",
			toAgentId: sibling.agent.id,
		});

		expect(sentToChild.message).toMatchObject({
			body: "Please inspect auth",
			fromAgentId: parent.agent.id,
			kind: "message",
			status: "pending",
			toAgentId: child.agent.id,
		});
		expect(sentToChild.agent).toMatchObject({
			id: parent.agent.id,
			lastActivity: { description: "Sent mailbox message" },
			revision: parent.agent.revision + 1,
		});
		expect(siblingAttempt).toMatchObject({
			ok: false,
			error: "forbidden_target",
			current: { id: child.agent.id, revision: child.agent.revision },
			target: { id: sibling.agent.id },
		});
		expect(store.listMailboxMessages()).toHaveLength(1);
	});

	it("wires rehydrated stores to persist later mutations", () => {
		const session = createControlDbSession();

		const rehydrated = MultiAgentStore.fromSessionManager(session, {
			now: () => "2026-06-21T00:00:00.000Z",
		});
		const spawned = spawnScout(rehydrated);
		const reopened = MultiAgentStore.fromSessionManager(session, {
			now: () => "2026-06-21T00:00:00.000Z",
		});

		expect(reopened.getAgent(spawned.agent.id)).toMatchObject({
			displayName: "Scout",
			id: spawned.agent.id,
			lifecycle: "queued",
		});
	});

	it("allocates persisted mailbox message IDs across concurrent rehydrated stores", () => {
		const session = createControlDbSession();
		const source = MultiAgentStore.fromSessionManager(session, {
			now: () => "2026-06-21T00:00:00.000Z",
		});
		const first = spawnScout(source);
		const second = source.spawnAgent({
			agentType: "scout",
			cwd: "/repo",
			displayName: "Second Scout",
			parentId: "root",
			permission: { narrowed: true, policy: "on-request" },
		});
		const left = MultiAgentStore.fromSessionManager(session, {
			now: () => "2026-06-21T00:00:01.000Z",
		});
		const right = MultiAgentStore.fromSessionManager(session, {
			now: () => "2026-06-21T00:00:02.000Z",
		});

		const leftContact = left.contactSupervisor(first.agent.id, first.agent.revision, { body: "left" });
		const rightContact = right.contactSupervisor(second.agent.id, second.agent.revision, { body: "right" });
		const controlDbPath = session.getMetadataControlDbPath();
		const sessionPath = session.getSessionFile();
		if (!controlDbPath || !sessionPath) throw new Error("expected control DB session");
		const state = readMultiAgentState(controlDbPath, sessionPath);

		expect(leftContact.ok && leftContact.message.id).toBe("message_1");
		expect(rightContact.ok && rightContact.message.id).toBe("message_2");
		expect(state?.mailboxMessages).toMatchObject([
			{ body: "left", id: "message_1" },
			{ body: "right", id: "message_2" },
		]);
		expect(state?.counters.nextMessageNumber).toBe(3);
	});

	it("restores crashed active agents with truthful lifecycles and cleared worker handles", () => {
		const session = createControlDbSession();
		const source = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		source.setPersistenceSessionManager(session);
		const recoverable = source.spawnAgent({
			agentType: "resumed-session",
			cwd: "/repo",
			displayName: "Recoverable",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: "/sessions/recoverable.jsonl", sessionId: "recoverable-session" },
			worker: { adapter: "subprocess", handleId: "dead-pid" },
		});
		const idle = source.spawnAgent({
			agentType: "resumed-session",
			cwd: "/repo",
			displayName: "Idle",
			lifecycle: "waiting_for_input",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: "/sessions/idle.jsonl", sessionId: "idle-session" },
			worker: { adapter: "subprocess", handleId: "old-idle-pid" },
		});
		const unrecoverable = source.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Unrecoverable",
			permission: { narrowed: true, policy: "on-request" },
			worker: { adapter: "subprocess", handleId: "dead-pid-2" },
		});
		const recoverableRunning = source.transitionAgent(recoverable.agent.id, recoverable.agent.revision, "starting");
		expect(recoverableRunning.ok).toBe(true);
		if (!recoverableRunning.ok) {
			throw new Error("expected recoverable start");
		}
		expect(source.transitionAgent(recoverable.agent.id, recoverableRunning.agent.revision, "running").ok).toBe(true);
		const unrecoverableRunning = source.transitionAgent(
			unrecoverable.agent.id,
			unrecoverable.agent.revision,
			"starting",
		);
		expect(unrecoverableRunning.ok).toBe(true);
		if (!unrecoverableRunning.ok) {
			throw new Error("expected unrecoverable start");
		}
		expect(source.transitionAgent(unrecoverable.agent.id, unrecoverableRunning.agent.revision, "running").ok).toBe(
			true,
		);

		const rehydrated = MultiAgentStore.fromSessionManager(session, {
			now: () => "2026-06-21T00:00:00.000Z",
		});

		expect(rehydrated.getAgent(recoverable.agent.id)).toMatchObject({
			id: recoverable.agent.id,
			lifecycle: "running",
			transcript: { path: "/sessions/recoverable.jsonl", sessionId: "recoverable-session" },
		});
		expect(rehydrated.getAgent(recoverable.agent.id)?.worker).toBeUndefined();
		expect(rehydrated.getAgent(idle.agent.id)).toMatchObject({
			id: idle.agent.id,
			lifecycle: "waiting_for_input",
			transcript: { path: "/sessions/idle.jsonl", sessionId: "idle-session" },
		});
		expect(rehydrated.getAgent(idle.agent.id)?.worker).toBeUndefined();
		expect(rehydrated.getAgent(unrecoverable.agent.id)).toMatchObject({
			id: unrecoverable.agent.id,
			lifecycle: "running",
		});
		expect(rehydrated.getAgent(unrecoverable.agent.id)?.error).toBeUndefined();
		expect(rehydrated.getAgent(unrecoverable.agent.id)?.worker).toBeUndefined();
	});

	it("leaves queued agents queued during crash recovery", () => {
		const session = createControlDbSession();
		const source = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		source.setPersistenceSessionManager(session);
		const queued = spawnScout(source);

		const rehydrated = MultiAgentStore.fromSessionManager(session, {
			now: () => "2026-06-21T00:00:00.000Z",
		});

		expect(rehydrated.getAgent(queued.agent.id)).toMatchObject({
			lifecycle: "queued",
		});
	});

	it("keeps interrupted running agents running across repeated restores", () => {
		const session = createControlDbSession();
		const source = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		source.setPersistenceSessionManager(session);
		const interrupted = spawnScout(source);
		const started = source.transitionAgent(interrupted.agent.id, interrupted.agent.revision, "starting");
		expect(started.ok).toBe(true);
		if (!started.ok) throw new Error("expected start");
		expect(source.transitionAgent(interrupted.agent.id, started.agent.revision, "running").ok).toBe(true);

		MultiAgentStore.fromSessionManager(session, {
			now: () => "2026-06-21T00:00:00.000Z",
		});
		const reopened = MultiAgentStore.fromSessionManager(session, {
			now: () => "2026-06-21T00:00:00.000Z",
		});

		expect(reopened.getAgent(interrupted.agent.id)).toMatchObject({
			lifecycle: "running",
		});
		expect(reopened.getAgent(interrupted.agent.id)?.error).toBeUndefined();
	});

	it("persists agent state as control DB rows instead of transcript entries", () => {
		const session = createControlDbSession();
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		store.setPersistenceSessionManager(session);
		const spawned = spawnScout(store);
		const viewed = store.selectAgentView(spawned.agent.id);
		const controlDbPath = session.getMetadataControlDbPath();
		const sessionPath = session.getSessionFile();
		if (!controlDbPath || !sessionPath) throw new Error("expected control DB session");

		const state = readMultiAgentState(controlDbPath, sessionPath);

		expect(viewed?.id).toBe(spawned.agent.id);
		expect(state?.agents).toMatchObject([{ displayName: "Scout", id: spawned.agent.id, lifecycle: "queued" }]);
		expect(state?.counters).toEqual({ nextAgentNumber: 2, nextMessageNumber: 1 });
		expect(state?.mailboxMessages).toEqual([]);
		expect(session.getEntries().some((entry) => entry.type === "custom")).toBe(false);
	});

	it("persists waiting-for-input notifications across session restore", () => {
		const session = createControlDbSession();
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		store.setPersistenceSessionManager(session);
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
		const waiting = store.transitionAgent(spawned.agent.id, running.agent.revision, "waiting_for_input");
		expect(waiting.ok).toBe(true);

		const rehydrated = MultiAgentStore.fromSessionManager(session, {
			now: () => "2026-06-21T00:00:00.000Z",
		});

		expect(rehydrated.listMailboxMessages()).toMatchObject([
			{
				body: "Scout is waiting for input.",
				fromAgentId: spawned.agent.id,
				kind: "system",
				status: "pending",
				threadId: `agent-waiting-for-input:${spawned.agent.id}`,
				toAgentId: "root",
			},
		]);
	});

	it("rehydrates the latest persisted state after reopening a session", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-multi-agent-store-"));
		try {
			const session = SessionManager.create(tempDir, join(tempDir, "sessions"));
			session.setMetadataControlDbPath(getControlDbPath(tempDir));
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
			store.setPersistenceSessionManager(session);
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
			if (!steer.ok) {
				throw new Error("expected steer to succeed");
			}
			const delivered = store.ackSteering(spawned.agent.id, steer.agent.revision, steer.message.id, "delivered");
			expect(delivered.ok).toBe(true);
			if (!delivered.ok) {
				throw new Error("expected steering delivery");
			}
			const completed = store.transitionAgent(spawned.agent.id, delivered.agent.revision, "completed");
			expect(completed.ok).toBe(true);
			store.selectAgentView(spawned.agent.id);

			const sessionFile = session.getSessionFile();
			if (!sessionFile) {
				throw new Error("expected persisted session file");
			}
			const reopenedSession = SessionManager.open(sessionFile);
			reopenedSession.setMetadataControlDbPath(getControlDbPath(tempDir));
			const rehydrated = MultiAgentStore.fromSessionManager(reopenedSession, {
				now: () => "2026-06-21T00:00:00.000Z",
			});

			expect(rehydrated.getAgent(spawned.agent.id)).toMatchObject({
				id: spawned.agent.id,
				lifecycle: "completed",
				revision: 6,
			});
			expect(rehydrated.getSelectedAgentId()).toBeUndefined();
			expect(rehydrated.getActiveAgentCount()).toBe(0);
			expect(rehydrated.listMailboxMessages()).toMatchObject([
				{
					body: "Continue with tests",
					kind: "steer",
					status: "delivered",
				},
				{
					body: "Scout completed.",
					kind: "system",
					status: "pending",
				},
			]);
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});
});
