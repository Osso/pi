import { type ChildProcess, spawn } from "node:child_process";
import {
	chmodSync,
	closeSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	openSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { type AgentSessionServices, createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { cleanupDetachedJobArtifacts } from "../src/core/detached-job-cleanup.ts";
import { LifecycleCoordinator } from "../src/core/lifecycle-coordinator.ts";
import type { AgentSnapshot } from "../src/core/multi-agent-store.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { readProcessIdentity } from "../src/core/runtime-process.ts";
import {
	bootstrapMultiAgentAgent,
	createFailedMultiAgentChild,
	createMultiAgentChildWithRuntimeOwnership,
	getControlDbPath,
	writeSessionMetadata,
} from "../src/core/session-control-db.ts";
import { reopenSessionWithCwd } from "../src/core/session-cwd.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { deliverTerminalOutboxProjections } from "../src/core/terminal-outbox-delivery.ts";
import {
	createProductionAttachedSessionFactory,
	deliverTerminalOutboxForStore,
} from "../src/extensions/multi-agent.ts";
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
	const artifactDirectory = join(input.root, "detached-jobs", input.sessionName, input.jobId);
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

function persistOwnedDetachedArtifact(input: {
	controlDbPath: string;
	jobId: string;
	processIdentity: ReturnType<typeof readProcessIdentity>;
	root: string;
	sessionName: string;
	size: number;
	updatedAt: string;
}): string {
	const sessionDirectory = join(input.root, "sessions", "project");
	const sessionPath = join(sessionDirectory, `${input.sessionName}.jsonl`);
	const artifactDirectory = join(input.root, "detached-jobs", input.sessionName, input.jobId);
	const outputPath = join(artifactDirectory, "output.log");
	mkdirSync(artifactDirectory, { recursive: true });
	writeFileSync(outputPath, "output", { mode: 0o600 });
	truncateSync(outputPath, input.size);
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
	const agent: AgentSnapshot = {
		agentType: "background",
		createdAt: input.updatedAt,
		cwd: input.root,
		detached: true,
		displayName: "Detached job",
		id: input.jobId,
		lifecycle: "running",
		parentId: "main",
		permission: { narrowed: true, policy: "on-request" },
		result: { fileRefs: [{ label: "Pyrun output", path: outputPath }] },
		revision: 1,
		updatedAt: input.updatedAt,
		worker: { adapter: "runtime", handleId: String(input.processIdentity.pid) },
	};
	const created = createMultiAgentChildWithRuntimeOwnership(input.controlDbPath, {
		agent,
		agentId: input.jobId,
		nowIso: input.updatedAt,
		owner: { agentId: null, sessionId: "owner-session" },
		processIdentity: input.processIdentity,
		sessionPath,
	});
	if (!created.ok) throw new Error(`Could not persist detached artifact fixture: ${created.error}`);
	return artifactDirectory;
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
	child.kill("SIGKILL");
	await new Promise<void>((resolve) => child.once("exit", () => resolve()));
	childProcesses.delete(child);
}

async function createRuntimeResult(root: string) {
	return {
		diagnostics: [],
		extensionsResult: await createTestExtensionsResult([], root),
		services: { agentDir: root, cwd: root } as AgentSessionServices,
		session: { extensionRunner: { setRelocateHandler: () => {} } } as unknown as AgentSession,
	};
}

function persistFailedOutboxAgent(input: {
	completedAt: string;
	controlDbPath: string;
	id: string;
	root: string;
	sessionPath: string;
}): void {
	const failedAgent: AgentSnapshot = {
		agentType: "verifier",
		createdAt: input.completedAt,
		cwd: input.root,
		displayName: "Verifier",
		id: input.id,
		lifecycle: "failed",
		parentId: "main",
		permission: { narrowed: true, policy: "on-request" },
		revision: 1,
		updatedAt: input.completedAt,
	};
	const created = createFailedMultiAgentChild(input.controlDbPath, {
		agent: failedAgent,
		nowIso: input.completedAt,
		sessionPath: input.sessionPath,
	});
	if (!created.ok) throw new Error(`Could not persist terminal outbox fixture: ${created.error}`);
}

describe("detached job artifact cleanup", () => {
	it("cleans production artifacts when agent and control database roots differ", () => {
		const stateRoot = createRoot();
		const agentRoot = createRoot();
		const controlDbPath = getControlDbPath(stateRoot);
		const expired = persistArtifact({
			controlDbPath,
			jobId: "bash_distinct_roots",
			lifecycle: "completed",
			root: agentRoot,
			sessionName: "distinct-roots",
			updatedAt: "2026-07-19T18:00:00.000Z",
		});

		const result = cleanupDetachedJobArtifacts(controlDbPath, { artifactRoot: agentRoot, now: NOW });

		expect(result.deletedDirectories).toEqual([expired]);
		expect(existsSync(expired)).toBe(false);
	});

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

		const result = cleanupDetachedJobArtifacts(controlDbPath, { artifactRoot: root, now: NOW });

		expect(result.deletedDirectories).toEqual([expired]);
		expect(existsSync(expired)).toBe(false);
		expect(existsSync(running)).toBe(true);
		expect(existsSync(referenced)).toBe(true);
	});

	it("preserves a terminal directory referenced through a symlinked cwd", () => {
		const container = createRoot();
		const realRoot = join(container, "real");
		const linkedRoot = join(container, "linked");
		mkdirSync(realRoot);
		symlinkSync(realRoot, linkedRoot, "dir");
		const controlDbPath = getControlDbPath(realRoot);
		const referenced = persistArtifact({
			controlDbPath,
			jobId: "pyrun_symlink",
			lifecycle: "completed",
			root: linkedRoot,
			sessionName: "symlink-referenced",
			updatedAt: "2026-07-19T18:00:00.000Z",
		});
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			cwd: realpathSync(referenced),
			stdio: "ignore",
		});
		childProcesses.add(child);
		if (!child.pid) throw new Error("Expected child process ID");
		expect(readlinkSync(`/proc/${child.pid}/cwd`)).toBe(realpathSync(referenced));

		cleanupDetachedJobArtifacts(controlDbPath, { artifactRoot: linkedRoot, now: NOW });

		expect(existsSync(referenced)).toBe(true);
	});

	it("preserves a terminal directory containing a running executable", () => {
		const root = createRoot();
		const controlDbPath = getControlDbPath(root);
		const referenced = persistArtifact({
			controlDbPath,
			jobId: "pyrun_executable",
			lifecycle: "completed",
			root,
			sessionName: "executable-referenced",
			updatedAt: "2026-07-19T18:00:00.000Z",
		});
		const executablePath = join(referenced, "sleep");
		copyFileSync("/usr/bin/sleep", executablePath);
		chmodSync(executablePath, 0o700);
		const child = spawn(executablePath, ["30"], { argv0: "sleep", cwd: root, stdio: "ignore" });
		childProcesses.add(child);
		if (!child.pid) throw new Error("Expected child process ID");

		cleanupDetachedJobArtifacts(controlDbPath, { artifactRoot: root, now: NOW });

		expect(existsSync(referenced)).toBe(true);
	});

	it("preserves a terminal directory containing an open file descriptor", () => {
		const root = createRoot();
		const controlDbPath = getControlDbPath(root);
		const referenced = persistArtifact({
			controlDbPath,
			jobId: "pyrun_descriptor",
			lifecycle: "completed",
			root,
			sessionName: "descriptor-referenced",
			updatedAt: "2026-07-19T18:00:00.000Z",
		});
		const descriptor = openSync(join(referenced, "output.log"), "r");
		try {
			const result = cleanupDetachedJobArtifacts(controlDbPath, { artifactRoot: root, now: NOW });

			expect(result.deletedDirectories).toEqual([]);
			expect(existsSync(referenced)).toBe(true);
		} finally {
			closeSync(descriptor);
		}
	});

	it("restores a quarantined directory acquired as a process cwd after candidate selection", () => {
		const root = createRoot();
		const controlDbPath = getControlDbPath(root);
		const referenced = persistArtifact({
			controlDbPath,
			jobId: "pyrun_quarantine_race",
			lifecycle: "completed",
			root,
			sessionName: "quarantine-race",
			updatedAt: "2026-07-19T18:00:00.000Z",
		});

		const result = cleanupDetachedJobArtifacts(controlDbPath, {
			artifactRoot: root,
			now: NOW,
			onDirectoryQuarantined: (quarantinePath) => {
				const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
					cwd: quarantinePath,
					stdio: "ignore",
				});
				childProcesses.add(child);
				if (!child.pid) throw new Error("Expected child process ID");
				expect(readlinkSync(`/proc/${child.pid}/cwd`)).toBe(quarantinePath);
			},
		});

		expect(result.deletedDirectories).toEqual([]);
		expect(existsSync(referenced)).toBe(true);
	});

	it("does not preserve an artifact mentioned only in an unrelated process argument", () => {
		const root = createRoot();
		const controlDbPath = getControlDbPath(root);
		const expired = persistArtifact({
			controlDbPath,
			jobId: "pyrun_argument",
			lifecycle: "completed",
			root,
			sessionName: "argument-only",
			updatedAt: "2026-07-19T18:00:00.000Z",
		});
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", join(expired, "output.log")], {
			cwd: root,
			stdio: "ignore",
		});
		childProcesses.add(child);
		if (!child.pid) throw new Error("Expected child process ID");

		cleanupDetachedJobArtifacts(controlDbPath, { artifactRoot: root, now: NOW });

		expect(existsSync(expired)).toBe(false);
	});

	it("refuses a matching detached path outside the agent artifact root", () => {
		const root = createRoot();
		const controlDbPath = getControlDbPath(root);
		const sessionName = "external-path";
		const jobId = "pyrun_external";
		const sessionPath = join(root, "sessions", "project", `${sessionName}.jsonl`);
		const externalDirectory = join(root, "unrelated", "detached-jobs", sessionName, jobId);
		const outputPath = join(externalDirectory, "output.log");
		mkdirSync(externalDirectory, { recursive: true });
		writeFileSync(outputPath, "output", { mode: 0o600 });
		writeSessionMetadata(controlDbPath, {
			allMessagesText: sessionName,
			createdAt: "2026-07-19T18:00:00.000Z",
			cwd: root,
			firstMessage: sessionName,
			id: `session-${sessionName}`,
			messageCount: 1,
			modifiedAt: "2026-07-19T18:00:00.000Z",
			name: undefined,
			parentSessionPath: undefined,
			sessionPath,
		});
		bootstrapMultiAgentAgent(controlDbPath, sessionPath, jobId, {
			agentType: "background",
			createdAt: "2026-07-19T18:00:00.000Z",
			cwd: root,
			displayName: "Detached job",
			id: jobId,
			lifecycle: "completed",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
			result: { fileRefs: [{ label: "Pyrun output", path: outputPath }] },
			revision: 2,
			updatedAt: "2026-07-19T18:00:00.000Z",
		});

		const result = cleanupDetachedJobArtifacts(controlDbPath, { artifactRoot: root, now: NOW });

		expect(result.deletedDirectories).toEqual([]);
		expect(existsSync(externalDirectory)).toBe(true);
	});

	it("refuses an artifact path redirected outside the root by a symlinked session directory", () => {
		const root = createRoot();
		const controlDbPath = getControlDbPath(root);
		const sessionName = "symlink-escape";
		const jobId = "pyrun_symlink_escape";
		const sessionPath = join(root, "sessions", "project", `${sessionName}.jsonl`);
		const externalSessionDirectory = join(root, "outside", sessionName);
		const externalDirectory = join(externalSessionDirectory, jobId);
		const detachedRoot = join(root, "detached-jobs");
		mkdirSync(externalDirectory, { recursive: true });
		mkdirSync(detachedRoot, { recursive: true });
		symlinkSync(externalSessionDirectory, join(detachedRoot, sessionName), "dir");
		const outputPath = join(detachedRoot, sessionName, jobId, "output.log");
		writeFileSync(outputPath, "output", { mode: 0o600 });
		writeSessionMetadata(controlDbPath, {
			allMessagesText: sessionName,
			createdAt: "2026-07-19T18:00:00.000Z",
			cwd: root,
			firstMessage: sessionName,
			id: `session-${sessionName}`,
			messageCount: 1,
			modifiedAt: "2026-07-19T18:00:00.000Z",
			name: undefined,
			parentSessionPath: undefined,
			sessionPath,
		});
		bootstrapMultiAgentAgent(controlDbPath, sessionPath, jobId, {
			agentType: "background",
			createdAt: "2026-07-19T18:00:00.000Z",
			cwd: root,
			displayName: "Detached job",
			id: jobId,
			lifecycle: "completed",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
			result: { fileRefs: [{ label: "Bash output", path: outputPath }] },
			revision: 2,
			updatedAt: "2026-07-19T18:00:00.000Z",
		});

		const result = cleanupDetachedJobArtifacts(controlDbPath, { artifactRoot: root, now: NOW });

		expect(result.deletedDirectories).toEqual([]);
		expect(existsSync(externalDirectory)).toBe(true);
	});

	it("refuses a detached job ID containing path traversal", () => {
		const root = createRoot();
		const controlDbPath = getControlDbPath(root);
		const sessionName = "traversal";
		const jobId = "../escaped-job";
		const sessionPath = join(root, "sessions", "project", `${sessionName}.jsonl`);
		const escapedDirectory = join(root, "detached-jobs", "escaped-job");
		const outputPath = join(escapedDirectory, "output.log");
		mkdirSync(escapedDirectory, { recursive: true });
		writeFileSync(outputPath, "output", { mode: 0o600 });
		writeSessionMetadata(controlDbPath, {
			allMessagesText: sessionName,
			createdAt: "2026-07-19T18:00:00.000Z",
			cwd: root,
			firstMessage: sessionName,
			id: `session-${sessionName}`,
			messageCount: 1,
			modifiedAt: "2026-07-19T18:00:00.000Z",
			name: undefined,
			parentSessionPath: undefined,
			sessionPath,
		});
		bootstrapMultiAgentAgent(controlDbPath, sessionPath, jobId, {
			agentType: "background",
			createdAt: "2026-07-19T18:00:00.000Z",
			cwd: root,
			displayName: "Detached job",
			id: jobId,
			lifecycle: "completed",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
			result: { fileRefs: [{ label: "Pyrun output", path: outputPath }] },
			revision: 2,
			updatedAt: "2026-07-19T18:00:00.000Z",
		});

		const result = cleanupDetachedJobArtifacts(controlDbPath, { artifactRoot: root, now: NOW });

		expect(result.deletedDirectories).toEqual([]);
		expect(existsSync(escapedDirectory)).toBe(true);
	});

	it("refuses a session filename that resolves outside detached-jobs", () => {
		const root = createRoot();
		const controlDbPath = getControlDbPath(root);
		const escaped = persistArtifact({
			controlDbPath,
			jobId: "escaped-session-job",
			lifecycle: "completed",
			root,
			sessionName: "..",
			updatedAt: "2026-07-19T18:00:00.000Z",
		});

		const result = cleanupDetachedJobArtifacts(controlDbPath, { artifactRoot: root, now: NOW });

		expect(result.deletedDirectories).toEqual([]);
		expect(existsSync(escaped)).toBe(true);
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

		const result = cleanupDetachedJobArtifacts(controlDbPath, { artifactRoot: root, now: NOW });

		expect(result.deletedDirectories).toEqual([oldest]);
		expect(existsSync(oldest)).toBe(false);
		expect(existsSync(newest)).toBe(true);
	});

	it("cleans over-cap artifacts after startup reconciliation terminalizes a dead detached job", async () => {
		const root = createRoot();
		const controlDbPath = getControlDbPath(root);
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		childProcesses.add(child);
		if (!child.pid) throw new Error("Expected child process ID");
		const processIdentity = readProcessIdentity(child.pid);
		const artifact = persistOwnedDetachedArtifact({
			controlDbPath,
			jobId: "pyrun_dead",
			processIdentity,
			root,
			sessionName: "dead-runtime",
			size: 3 * ONE_GIB,
			updatedAt: "2026-07-19T18:00:00.000Z",
		});
		expect(existsSync(artifact)).toBe(true);
		await stopChildProcess(child);

		expect(LifecycleCoordinator.reconcileDeadDetachedRuntimes(controlDbPath, new Date(NOW).toISOString(), root)).toBe(
			1,
		);

		expect(existsSync(artifact)).toBe(false);
	});

	it("runs startup cleanup after replacing a session whose stored cwd is missing", async () => {
		const root = createRoot();
		const controlDbPath = getControlDbPath(root);
		const expired = persistArtifact({
			controlDbPath,
			jobId: "pyrun_replaced_startup",
			lifecycle: "completed",
			root,
			sessionName: "replaced-startup-expired",
			updatedAt: "2026-07-19T18:00:00.000Z",
		});
		const sessionDir = join(root, "sessions", "resumed");
		const sessionFile = join(sessionDir, "missing-cwd.jsonl");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "missing-cwd-session",
				timestamp: new Date(NOW).toISOString(),
				cwd: join(root, "missing"),
			})}\n`,
		);
		const sessionManager = reopenSessionWithCwd(
			{ fallbackCwd: root, sessionCwd: join(root, "missing"), sessionFile },
			sessionDir,
			root,
			controlDbPath,
		);

		await createAgentSessionRuntime(async () => createRuntimeResult(root), {
			agentDir: root,
			cwd: root,
			sessionManager,
		});

		expect(existsSync(expired)).toBe(false);
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

	it("uses an attached-only factory's custom artifact root for terminal cleanup", () => {
		const stateRoot = createRoot();
		const agentRoot = createRoot();
		const controlDbPath = getControlDbPath(stateRoot);
		const expired = persistArtifact({
			controlDbPath,
			jobId: "pyrun_attached_root",
			lifecycle: "completed",
			root: agentRoot,
			sessionName: "attached-root-expired",
			updatedAt: "2026-07-19T18:00:00.000Z",
		});
		const sessionManager = SessionManager.create(agentRoot, join(agentRoot, "sessions", "current"));
		sessionManager.setMetadataControlDbPath(controlDbPath);
		const sessionPath = sessionManager.getSessionFile();
		if (!sessionPath) throw new Error("Expected persisted session path");
		persistFailedOutboxAgent({
			completedAt: new Date(NOW).toISOString(),
			controlDbPath,
			id: "agent_attached_root",
			root: agentRoot,
			sessionPath,
		});
		const store = new MultiAgentStore();
		store.setPersistenceSessionManager(sessionManager);
		createProductionAttachedSessionFactory({
			agentDir: agentRoot,
			createSession: async () => {
				throw new Error("Attached session creation is not expected");
			},
			multiAgentStore: store,
		});

		expect(deliverTerminalOutboxForStore(store)).toBe(1);
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
		persistFailedOutboxAgent({ completedAt, controlDbPath, id: "agent_terminal", root, sessionPath });
		const store = new MultiAgentStore();
		store.setPersistenceSessionManager(sessionManager);

		expect(
			deliverTerminalOutboxProjections({
				artifactRoot: root,
				claimId: "cleanup-test",
				controlDbPath,
				now: () => completedAt,
				store,
			}),
		).toBe(1);

		expect(existsSync(expired)).toBe(false);
	});

	it("runs cleanup when a later terminal projection fails after an earlier delivery", () => {
		const root = createRoot();
		const controlDbPath = getControlDbPath(root);
		const expired = persistArtifact({
			controlDbPath,
			jobId: "pyrun_partial_delivery",
			lifecycle: "completed",
			root,
			sessionName: "partial-delivery-expired",
			updatedAt: "2026-07-19T18:00:00.000Z",
		});
		const sessionManager = SessionManager.create(root, join(root, "sessions", "current"));
		sessionManager.setMetadataControlDbPath(controlDbPath);
		const sessionPath = sessionManager.getSessionFile();
		if (!sessionPath) throw new Error("Expected persisted session path");
		const completedAt = new Date(NOW).toISOString();
		persistFailedOutboxAgent({ completedAt, controlDbPath, id: "agent_first", root, sessionPath });
		persistFailedOutboxAgent({ completedAt, controlDbPath, id: "agent_second", root, sessionPath });
		const store = new MultiAgentStore();
		store.setPersistenceSessionManager(sessionManager);
		let projectionCount = 0;
		const unsubscribe = store.subscribeLifecycleNotifications(() => {
			projectionCount += 1;
			if (projectionCount === 2) throw new Error("later projection failed");
		});

		expect(() =>
			deliverTerminalOutboxProjections({
				artifactRoot: root,
				claimId: "partial-cleanup-test",
				controlDbPath,
				now: () => completedAt,
				store,
			}),
		).toThrow("later projection failed");
		unsubscribe();

		expect(existsSync(expired)).toBe(false);
	});
});
