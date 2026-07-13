import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cancelOwnedAgentRuntime, createMultiAgentRuntimeHandles } from "../extensions/agents-core/src/runtime.ts";
import { runDurableDetachablePyrunEvaluation } from "../extensions/pyrun/src/detached-evaluation.ts";
import {
	readDetachedPyrunLaunchManifest,
	writeDetachedPyrunLaunchManifest,
} from "../extensions/pyrun/src/detached-runner.ts";
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

describe("resuming a detached Pyrun job whose lifecycle is cancelling", () => {
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
