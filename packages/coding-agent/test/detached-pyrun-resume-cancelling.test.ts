import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cancelOwnedAgentRuntime, createMultiAgentRuntimeHandles } from "../extensions/agents-core/src/runtime.ts";
import { runDurableDetachablePyrunEvaluation } from "../extensions/pyrun/src/detached-evaluation.ts";
import {
	readDetachedPyrunLaunchManifest,
	writeDetachedPyrunLaunchManifest,
} from "../extensions/pyrun/src/detached-runner.ts";
import { createCanonicalPyrunEvalParams } from "../extensions/pyrun/src/eval-tool.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import {
	getControlDbPath,
	readMultiAgentAgent,
	registerRuntimeMailboxListener,
} from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { ToolDetachRegistry } from "../src/core/tool-detach-registry.ts";
import { CURRENT_PROCESS_IDENTITY } from "./helpers/process-identity.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

interface CancellingJobFixture {
	controlDbPath: string;
	evalInput: Parameters<typeof runDurableDetachablePyrunEvaluation>[0];
	manifestPath: string;
	root: string;
	sessionManager: SessionManager;
	sessionPath: string;
}

async function wedgeCancellingPyrunJob(toolCallId: string): Promise<CancellingJobFixture> {
	const root = mkdtempSync(join(tmpdir(), "pi-pyrun-resume-cancel-"));
	temporaryDirectories.push(root);
	const runnerPath = join(root, "fake-pyrun.mjs");
	writeFileSync(
		runnerPath,
		[
			"#!/usr/bin/env node",
			"import { createInterface } from 'node:readline';",
			"const lines = createInterface({ input: process.stdin });",
			"for await (const line of lines) {",
			"  JSON.parse(line);",
			"  process.stdout.write(JSON.stringify({ type: 'progress', message: 'started' }) + '\\n');",
			"  await new Promise((resolve) => setTimeout(resolve, 60000));",
			"}",
		].join("\n"),
	);
	chmodSync(runnerPath, 0o700);
	const sessionManager = SessionManager.create(root, join(root, "sessions"));
	const controlDbPath = getControlDbPath(root);
	sessionManager.setMetadataControlDbPath(controlDbPath);
	const store = new MultiAgentStore();
	store.setPersistenceSessionManager(sessionManager);
	const sessionPath = sessionManager.getSessionFile();
	if (!sessionPath) throw new Error("Expected persisted Pyrun test session");
	registerRuntimeMailboxListener(
		controlDbPath,
		{ agentId: null, sessionId: sessionManager.getSessionId() },
		CURRENT_PROCESS_IDENTITY.pid,
		sessionPath,
		{ runtimeInstanceId: JSON.stringify(CURRENT_PROCESS_IDENTITY) },
	);
	const detachRegistry = new ToolDetachRegistry();
	const evalInput = {
		ctx: {
			controlDbPath,
			cwd: root,
			footerData: undefined,
			getContextUsage: () => undefined,
			model: undefined,
			sessionManager,
			toolExecutionStartedAt: Date.now(),
		} as unknown as ExtensionContext,
		detachRegistry,
		dispatchPiRequest: () => {
			throw new Error("Pi bridge disabled");
		},
		params: { code: "run forever" },
		piBridgeEnabled: false,
		runnerOptions: { command: runnerPath },
		store,
		toolCallId,
	} as const;

	const firstEvaluation = runDurableDetachablePyrunEvaluation({ ...evalInput });
	await waitFor(() => detachRegistry.detachRunning());
	const detached = await firstEvaluation;
	expect(detached.details).toMatchObject({ backgroundJobId: "pyrun_1" });

	// Kill the detached runner before it can process a cancel command, so the job
	// stays wedged in `cancelling` — the exact state a Pi restart re-adopts.
	const manifestPath = join(
		dirname(sessionPath),
		"detached-jobs",
		basename(sessionPath, extname(sessionPath)),
		"pyrun_1",
		"launch.json",
	);
	killProcessGroup(readDetachedPyrunLaunchManifest(manifestPath).runnerProcessIdentity.pid);

	const cancelled = await cancelOwnedAgentRuntime(store, createMultiAgentRuntimeHandles(), "pyrun_1");
	expect(cancelled.ok).toBe(true);
	expect(readMultiAgentAgent(controlDbPath, sessionPath, "pyrun_1")?.lifecycle).toBe("cancelling");

	return { controlDbPath, evalInput, manifestPath, root, sessionManager, sessionPath };
}

interface RestorablePyrunArtifactFixture extends CancellingJobFixture {
	directory: string;
	outputPath: string;
	scriptPath: string;
}

function createRestorablePyrunArtifact(toolCallId: string, output: string): RestorablePyrunArtifactFixture {
	const root = mkdtempSync(join(tmpdir(), "pi-pyrun-restore-artifact-"));
	temporaryDirectories.push(root);
	const sessionManager = SessionManager.create(root, join(root, "sessions"));
	const controlDbPath = getControlDbPath(root);
	sessionManager.setMetadataControlDbPath(controlDbPath);
	const store = new MultiAgentStore();
	store.setPersistenceSessionManager(sessionManager);
	const sessionPath = sessionManager.getSessionFile();
	if (!sessionPath) throw new Error("Expected persisted Pyrun test session");
	const ctx = {
		controlDbPath,
		cwd: root,
		footerData: undefined,
		getContextUsage: () => undefined,
		model: undefined,
		sessionManager,
		toolExecutionStartedAt: Date.now(),
	} as unknown as ExtensionContext;
	const params = { code: "original code" };
	const evalInput = {
		ctx,
		detachRegistry: new ToolDetachRegistry(),
		dispatchPiRequest: () => {
			throw new Error("Pi bridge disabled");
		},
		params,
		piBridgeEnabled: false,
		runnerOptions: { command: join(root, "missing-pyrun") },
		store,
		toolCallId,
	} as const;
	const directory = join(
		dirname(sessionPath),
		"detached-jobs",
		basename(sessionPath, extname(sessionPath)),
		"pyrun_1",
	);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const outputPath = join(directory, "output.log");
	const scriptPath = join(directory, "script.py");
	const manifestPath = join(directory, "launch.json");
	writeFileSync(outputPath, output, { mode: 0o600 });
	writeFileSync(scriptPath, `${params.code}\n`, { mode: 0o600 });
	const deadRunnerProcessIdentity = {
		...CURRENT_PROCESS_IDENTITY,
		startTimeTicks: CURRENT_PROCESS_IDENTITY.startTimeTicks + 1,
	};
	writeDetachedPyrunLaunchManifest(manifestPath, {
		activationPath: join(directory, "activation.json"),
		artifacts: { directory, outputPath },
		bridgeRequestPath: join(directory, "bridge-requests.jsonl"),
		bridgeResponsePath: join(directory, "bridge-responses.jsonl"),
		controlDbPath,
		foregroundCompletionPath: join(directory, "foreground-completed"),
		params: createCanonicalPyrunEvalParams(params, ctx, false),
		runnerAddress: { agentId: "pyrun_1", sessionId: sessionManager.getSessionId() },
		runnerOptions: evalInput.runnerOptions,
		runnerProcessIdentity: deadRunnerProcessIdentity,
		sessionPath,
		startedAt: Date.now() - 100,
		supervisorProcessIdentity: CURRENT_PROCESS_IDENTITY,
		toolCallId,
	});
	return {
		controlDbPath,
		directory,
		evalInput,
		manifestPath,
		outputPath,
		root,
		scriptPath,
		sessionManager,
		sessionPath,
	};
}

function pyrunJobDirectory(fixture: CancellingJobFixture, jobId: string): string {
	return join(
		dirname(fixture.sessionPath),
		"detached-jobs",
		basename(fixture.sessionPath, extname(fixture.sessionPath)),
		jobId,
	);
}

async function replayInterruptedCall(
	fixture: CancellingJobFixture,
	overrides: Partial<Parameters<typeof runDurableDetachablePyrunEvaluation>[0]>,
) {
	const resumeStore = new MultiAgentStore();
	resumeStore.setPersistenceSessionManager(fixture.sessionManager);
	return runDurableDetachablePyrunEvaluation({
		...fixture.evalInput,
		ctx: { ...fixture.evalInput.ctx, toolExecutionStartedAt: Date.now() } as unknown as ExtensionContext,
		detachRegistry: new ToolDetachRegistry(),
		store: resumeStore,
		...overrides,
	});
}

describe("resuming durable Pyrun artifacts", () => {
	it("replays a complete terminal result without launching replacement code", async () => {
		const output = [
			JSON.stringify({ kind: "progress", update: { stream: "stdout", text: "streamed output\n", type: "console" } }),
			JSON.stringify({
				kind: "result",
				result: { console: ["terminal output"], executed: "original code", type: "completed", value: 42 },
			}),
			"",
		].join("\n");
		const fixture = createRestorablePyrunArtifact("restore-result-call", output);

		const resumed = await replayInterruptedCall(fixture, {});

		expect(resumed).toMatchObject({ details: { type: "completed", value: 42 }, isError: false });
		expect(JSON.stringify(resumed.content)).toContain("terminal output");
		expect(readFileSync(fixture.outputPath, "utf8")).toBe(output);
		expect(existsSync(fixture.manifestPath)).toBe(true);
		expect(existsSync(fixture.scriptPath)).toBe(true);
		expect(existsSync(pyrunJobDirectory(fixture, "pyrun_2"))).toBe(false);
	});

	it("replays a complete terminal error with preceding console output", async () => {
		const output = [
			JSON.stringify({ kind: "progress", update: { stream: "stdout", text: "before failure\n", type: "console" } }),
			JSON.stringify({ error: "failed durably", kind: "error" }),
			"",
		].join("\n");
		const fixture = createRestorablePyrunArtifact("restore-error-call", output);

		const resumed = await replayInterruptedCall(fixture, {});

		expect(resumed).toMatchObject({ details: { error: "failed durably", type: "error" }, isError: true });
		expect(JSON.stringify(resumed.content)).toContain("before failure");
		expect(JSON.stringify(resumed.content)).toContain("failed durably");
		expect(readFileSync(fixture.outputPath, "utf8")).toBe(output);
		expect(existsSync(pyrunJobDirectory(fixture, "pyrun_2"))).toBe(false);
	});

	it("ignores an incomplete trailing record when reporting a lost runtime", async () => {
		const output = `${JSON.stringify({
			kind: "progress",
			update: { stream: "stdout", text: "preserved output\n", type: "console" },
		})}\n{"kind":"result"`;
		const fixture = createRestorablePyrunArtifact("restore-partial-call", output);

		const resumed = await replayInterruptedCall(fixture, {});

		expect(resumed).toMatchObject({
			details: { outputPath: fixture.outputPath, type: "lost_runtime" },
			isError: true,
		});
		expect(JSON.stringify(resumed.content)).toContain("preserved output");
		expect(readFileSync(fixture.outputPath, "utf8")).toBe(output);
		expect(existsSync(fixture.manifestPath)).toBe(true);
		expect(existsSync(fixture.scriptPath)).toBe(true);
		expect(existsSync(pyrunJobDirectory(fixture, "pyrun_2"))).toBe(false);
	});

	it("settles the matched job to aborted instead of re-running it", async () => {
		const fixture = await wedgeCancellingPyrunJob("resume-cancel-call");

		const resumed = await replayInterruptedCall(fixture, {});

		expect(resumed).toMatchObject({ isError: true });
		expect(readMultiAgentAgent(fixture.controlDbPath, fixture.sessionPath, "pyrun_1")?.lifecycle).toBe("aborted");
		expect(readMultiAgentAgent(fixture.controlDbPath, fixture.sessionPath, "pyrun_2")).toBeUndefined();
		expect(existsSync(pyrunJobDirectory(fixture, "pyrun_2"))).toBe(false);
	});

	it("settles a legacy job with no recorded toolCallId that cannot be correlated", async () => {
		const fixture = await wedgeCancellingPyrunJob("legacy-cancel-call");

		// Simulate a manifest written before tool-call correlation existed: drop the
		// toolCallId so it can never equal the replayed call's toolCallId.
		const manifest = readDetachedPyrunLaunchManifest(fixture.manifestPath);
		const { checksum, version, toolCallId, ...data } = manifest;
		void checksum;
		void version;
		void toolCallId;
		writeDetachedPyrunLaunchManifest(fixture.manifestPath, {
			...data,
			toolCallId: undefined as unknown as string,
		});

		const resumed = await replayInterruptedCall(fixture, { toolCallId: "some-unrelated-call" });

		expect(resumed).toMatchObject({ isError: true });
		expect(readMultiAgentAgent(fixture.controlDbPath, fixture.sessionPath, "pyrun_1")?.lifecycle).toBe("aborted");
		expect(existsSync(pyrunJobDirectory(fixture, "pyrun_2"))).toBe(false);
	});
});

function killProcessGroup(pid: number): void {
	for (const target of [-pid, pid]) {
		try {
			process.kill(target, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for durable Pyrun evaluation");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
