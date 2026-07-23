import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readlinkSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { type AgentSessionServices, createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { cleanupDetachedJobArtifacts } from "../src/core/detached-job-cleanup.ts";
import type { AgentSnapshot } from "../src/core/multi-agent-store.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import {
	bootstrapMultiAgentAgent,
	createFailedMultiAgentChild,
	getControlDbPath,
	writeSessionMetadata,
} from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { deliverTerminalOutboxProjections } from "../src/core/terminal-outbox-delivery.ts";
import { createTestExtensionsResult } from "./utilities.ts";

const NOW = Date.parse("2026-07-23T18:00:00.000Z");
const ONE_GIB = 1024 ** 3;
const temporaryDirectories = new Set<string>();
const childProcesses = new Set<ChildProcess>();

afterEach(async () => {
	for (const child of childProcesses) {
		child.kill("SIGKILL");
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
	}
	childProcesses.clear();
	for (const directory of temporaryDirectories) rmSync(directory, { force: true, recursive: true });
	temporaryDirectories.clear();
});

function createRoot(): string {
	const root = join(tmpdir(), `pi-detached-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
	temporaryDirectories.add(root);
	return root;
}

function persistArtifact(input: {
	controlDbPath: string;
	jobId: string;
	lifecycle: AgentSnapshot["lifecycle"];
	root: string;
	sessionName: string;
	size?: number;
	updatedAt: string;
}): string {
	const sessionDirectory = join(input.root, "sessions", "project");
	const sessionPath = join(sessionDirectory, `${input.sessionName}.jsonl`);
	const artifactDirectory = join(sessionDirectory, "detached-jobs", input.sessionName, input.jobId);
	const outputPath = join(artifactDirectory, "output.log");
	mkdirSync(artifactDirectory, { recursive: true });
	writeFileSync(outputPath, "output", { mode: 0o600 });
	if (input.size !== undefined) truncateSync(outputPath, input.size);
	writeSessionMetadata(input.controlDbPath, {
		allMessagesText: input.sessionName,
		createdAt: input.updatedAt,
		cwd: input.root,
		firstMessage: input.sessionName,
		id: `session-${input.sessionName}`,
		messageCount: 1,
		modifiedAt: input.updatedAt,
		name: undefined,
		parentSessionPath: undefined,
		sessionPath,
	});
	bootstrapMultiAgentAgent(input.controlDbPath, sessionPath, input.jobId, {
		agentType: "background",
		createdAt: input.updatedAt,
		cwd: input.root,
		displayName: "Detached job",
		id: input.jobId,
		lifecycle: input.lifecycle,
		parentId: "main",
		permission: { narrowed: true, policy: "on-request" },
		result: { fileRefs: [{ label: "Pyrun output", path: outputPath }] },
		revision: input.lifecycle === "running" ? 1 : 2,
		updatedAt: input.updatedAt,
	});
	return artifactDirectory;
}

async function createRuntimeResult(root: string) {
	return {
		diagnostics: [],
		extensionsResult: await createTestExtensionsResult([], root),
		services: { agentDir: root, cwd: root } as AgentSessionServices,
		session: {} as AgentSession,
	};
}

describe("detached job artifact cleanup", () => {
	it("deletes expired terminal artifacts while preserving nonterminal and live-referenced directories", () => {
		const root = createRoot();
		const controlDbPath = getControlDbPath(root);
		const expired = persistArtifact({
			controlDbPath,
			jobId: "pyrun_expired",
			lifecycle: "completed",
			root,
			sessionName: "expired",
			updatedAt: "2026-07-19T18:00:00.000Z",
		});
		const running = persistArtifact({
			controlDbPath,
			jobId: "pyrun_running",
			lifecycle: "running",
			root,
			sessionName: "running",
			updatedAt: "2026-07-19T18:00:00.000Z",
		});
		const referenced = persistArtifact({
			controlDbPath,
			jobId: "pyrun_referenced",
			lifecycle: "completed",
			root,
			sessionName: "referenced",
			updatedAt: "2026-07-19T18:00:00.000Z",
		});
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			cwd: referenced,
			stdio: "ignore",
		});
		childProcesses.add(child);
		expect(child.pid).toBeDefined();
		expect(readlinkSync(`/proc/${child.pid}/cwd`)).toBe(referenced);

		const result = cleanupDetachedJobArtifacts(controlDbPath, { now: NOW });

		expect(result.deletedDirectories).toEqual([expired]);
		expect(existsSync(expired)).toBe(false);
		expect(existsSync(running)).toBe(true);
		expect(existsSync(referenced)).toBe(true);
	});

	it("deletes oldest recent terminal directories until retained bytes fit the two GiB cap", () => {
		const root = createRoot();
		const controlDbPath = getControlDbPath(root);
		const oldest = persistArtifact({
			controlDbPath,
			jobId: "pyrun_oldest",
			lifecycle: "completed",
			root,
			sessionName: "oldest",
			size: Math.ceil(1.1 * ONE_GIB),
			updatedAt: "2026-07-22T16:00:00.000Z",
		});
		const newest = persistArtifact({
			controlDbPath,
			jobId: "pyrun_newest",
			lifecycle: "completed",
			root,
			sessionName: "newest",
			size: Math.ceil(1.1 * ONE_GIB),
			updatedAt: "2026-07-22T17:00:00.000Z",
		});

		const result = cleanupDetachedJobArtifacts(controlDbPath, { now: NOW });

		expect(result.deletedDirectories).toEqual([oldest]);
		expect(existsSync(oldest)).toBe(false);
		expect(existsSync(newest)).toBe(true);
	});

	it("runs cleanup before creating the initial AgentSession runtime", async () => {
		const root = createRoot();
		const controlDbPath = getControlDbPath(root);
		const expired = persistArtifact({
			controlDbPath,
			jobId: "pyrun_startup",
			lifecycle: "completed",
			root,
			sessionName: "startup-expired",
			updatedAt: "2026-07-19T18:00:00.000Z",
		});
		const sessionManager = SessionManager.create(root, join(root, "sessions", "current"));
		sessionManager.setMetadataControlDbPath(controlDbPath);

		await createAgentSessionRuntime(async () => createRuntimeResult(root), {
			agentDir: root,
			cwd: root,
			sessionManager,
		});

		expect(existsSync(expired)).toBe(false);
	});

	it("runs cleanup after delivering a terminal completion", () => {
		const root = createRoot();
		const controlDbPath = getControlDbPath(root);
		const expired = persistArtifact({
			controlDbPath,
			jobId: "pyrun_delivery",
			lifecycle: "completed",
			root,
			sessionName: "delivery-expired",
			updatedAt: "2026-07-19T18:00:00.000Z",
		});
		const sessionManager = SessionManager.create(root, join(root, "sessions", "current"));
		sessionManager.setMetadataControlDbPath(controlDbPath);
		const sessionPath = sessionManager.getSessionFile();
		if (!sessionPath) throw new Error("Expected persisted session path");
		const completedAt = new Date(NOW).toISOString();
		const failedAgent: AgentSnapshot = {
			agentType: "verifier",
			createdAt: completedAt,
			cwd: root,
			displayName: "Verifier",
			id: "agent_terminal",
			lifecycle: "failed",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
			revision: 1,
			updatedAt: completedAt,
		};
		expect(
			createFailedMultiAgentChild(controlDbPath, {
				agent: failedAgent,
				nowIso: completedAt,
				sessionPath,
			}),
		).toMatchObject({ ok: true });
		const store = new MultiAgentStore();
		store.setPersistenceSessionManager(sessionManager);

		expect(
			deliverTerminalOutboxProjections({
				claimId: "cleanup-test",
				controlDbPath,
				now: () => completedAt,
				store,
			}),
		).toBe(1);

		expect(existsSync(expired)).toBe(false);
	});
});
