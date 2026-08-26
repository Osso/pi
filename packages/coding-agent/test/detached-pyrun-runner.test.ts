import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	enqueueDetachedPyrunBridgeResponse,
	parseDetachedPyrunBridgeRequest,
	validateDetachedPyrunBridgeRequest,
} from "../extensions/pyrun/src/detached-bridge.ts";
import {
	launchDetachedPyrunRunner,
	writeDetachedPyrunActivation,
	writeDetachedPyrunLaunchManifest,
} from "../extensions/pyrun/src/detached-runner.ts";
import { enqueueDetachedJobStatusRequest } from "../src/core/detached-job-control.ts";
import { createDetachedJobLifecycleController } from "../src/core/detached-job-lifecycle.ts";
import type { DetachedJobOwnershipIdentity } from "../src/core/detached-job-runner.ts";
import { LifecycleCoordinator } from "../src/core/lifecycle-coordinator.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { readProcessIdentity } from "../src/core/runtime-process.ts";
import {
	claimRuntimeMailboxMessages,
	enqueueRuntimeMailboxMessage,
	listRuntimeMailboxMessages,
	readMultiAgentAgent,
	readMultiAgentState,
	registerRuntimeMailboxListener,
	upsertMultiAgentMailboxMessage,
} from "../src/core/session-control-db.ts";
import { testProcessIdentity } from "./helpers/process-identity.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("detached Pyrun runner", () => {
	it("owns evaluation output and commits one exact terminal input", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-detached-pyrun-"));
		temporaryDirectories.push(root);
		const runnerPath = join(root, "fake-pyrun.mjs");
		writeFileSync(
			runnerPath,
			[
				"#!/usr/bin/env node",
				"import { createInterface } from 'node:readline';",
				"const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();",
				"const request = JSON.parse((await lines.next()).value);",
				"process.stdout.write(JSON.stringify({ type: 'progress', message: 'working' }) + '\\n');",
				"process.stdout.write(JSON.stringify({ type: 'pi_request', method: 'models.scoped', params: null }) + '\\n');",
				"const response = JSON.parse((await lines.next()).value);",
				"process.stdout.write(JSON.stringify({ type: 'completed', executed: request.code, value: response.result }) + '\\n');",
			].join("\n"),
		);
		chmodSync(runnerPath, 0o700);
		const controlDbPath = join(root, "control.sqlite");
		const sessionPath = join(root, "session.jsonl");
		const store = new MultiAgentStore();
		const coordinator = new LifecycleCoordinator({
			controlDbPath,
			createAgentId: () => store.allocateAgentIdForLifecycleCoordinator(),
			now: () => new Date().toISOString(),
			processIdentity: testProcessIdentity("pyrun-runner"),
			sessionPath,
		});
		const lifecycle = createDetachedJobLifecycleController({
			artifactRoot: root,
			controlDbPath,
			coordinator,
			ownerSessionId: "main",
			sessionPath,
			store,
		});
		const jobId = lifecycle.allocateJobId("pyrun");
		const artifacts = lifecycle.createArtifacts(jobId);
		const activationPath = join(artifacts.directory, "activation.json");
		const manifestPath = join(artifacts.directory, "launch.json");
		const runnerPid = launchDetachedPyrunRunner(manifestPath, {
			entryPath: join(import.meta.dirname, "../extensions/pyrun/src/detached-runner-entry.ts"),
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(existsSync(`${manifestPath}.runner-error`)).toBe(false);
		const ownership = lifecycle.register({
			agentType: "pyrun",
			cwd: root,
			displayName: "Pyrun evaluation",
			jobId,
			processIdentity: readProcessIdentity(runnerPid),
			workerHandleId: String(runnerPid),
		});
		const supervisorAddress = { agentId: null, sessionId: "main" };
		registerRuntimeMailboxListener(controlDbPath, supervisorAddress, process.pid);
		writeDetachedPyrunLaunchManifest(manifestPath, {
			activationPath,
			artifacts,
			bridgeRequestPath: join(artifacts.directory, "foreground-bridge-requests.jsonl"),
			bridgeResponsePath: join(artifacts.directory, "foreground-bridge-responses.jsonl"),
			controlDbPath,
			foregroundCompletionPath: join(artifacts.directory, "foreground-completed"),
			params: { code: "6 * 7" },
			runnerAddress: { agentId: jobId, sessionId: "main" },
			runnerOptions: { command: runnerPath, inheritEnv: true },
			runnerProcessIdentity: readProcessIdentity(runnerPid),
			sessionPath,
			startedAt: Date.now() - 1_000,
			supervisorProcessIdentity: readProcessIdentity(process.pid),
			toolCallId: "test-pyrun-tool-call",
		});
		writeDetachedPyrunActivation(activationPath, ownership.identity);

		await waitFor(() =>
			listRuntimeMailboxMessages(controlDbPath).some(
				(message) => message.recipient.agentId === null && message.status === "pending",
			),
		);
		const [bridgeMessage] = claimRuntimeMailboxMessages(controlDbPath, supervisorAddress);
		if (!bridgeMessage) throw new Error("Expected detached Pyrun bridge request");
		const bridgeRequest = parseDetachedPyrunBridgeRequest(bridgeMessage);
		if (!bridgeRequest) throw new Error("Expected valid detached Pyrun bridge request");
		expect(
			validateDetachedPyrunBridgeRequest({
				controlDbPath,
				message: bridgeMessage,
				nowIso: new Date().toISOString(),
				request: bridgeRequest,
				sessionPath,
				supervisorSessionId: "main",
			}),
		).toBe(true);
		expect(
			validateDetachedPyrunBridgeRequest({
				controlDbPath,
				message: bridgeMessage,
				nowIso: new Date().toISOString(),
				request: {
					...bridgeRequest,
					identity: { ...bridgeRequest.identity, processIdentity: testProcessIdentity("stale-runner") },
				},
				sessionPath,
				supervisorSessionId: "main",
			}),
		).toBe(false);
		enqueueDetachedPyrunBridgeResponse({
			controlDbPath,
			request: bridgeRequest,
			result: [{ id: "model-1" }],
			sessionPath,
			supervisorAddress,
		});
		await waitFor(() => {
			const agent = readMultiAgentState(controlDbPath, sessionPath)?.agents[0] as
				| { lifecycle?: unknown }
				| undefined;
			return agent?.lifecycle === "completed";
		});
		const output = readFileSync(artifacts.outputPath, "utf8");
		expect(output).toContain('"kind":"progress"');
		expect(output).toContain('"value":[{"id":"model-1"}]');
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toMatchObject([
			{ id: jobId, lifecycle: "completed", revision: 2 },
		]);
	});

	it.runIf(process.platform === "linux")(
		"keeps one stable control database connection while evaluation remains active",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "pi-detached-pyrun-retained-db-"));
			temporaryDirectories.push(root);
			const runnerPath = join(root, "fake-pyrun.mjs");
			writeFileSync(
				runnerPath,
				[
					"#!/usr/bin/env node",
					"import { createInterface } from 'node:readline';",
					"const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();",
					"const request = JSON.parse((await lines.next()).value);",
					"process.stdout.write(JSON.stringify({ type: 'progress', message: 'working' }) + '\\n');",
					"await new Promise((resolve) => setTimeout(resolve, 3_000));",
					"process.stdout.write(JSON.stringify({ type: 'completed', executed: request.code, value: 42 }) + '\\n');",
				].join("\n"),
			);
			chmodSync(runnerPath, 0o700);
			const controlDbPath = join(root, "control.sqlite");
			const sessionPath = join(root, "session.jsonl");
			const store = new MultiAgentStore();
			const coordinator = new LifecycleCoordinator({
				controlDbPath,
				createAgentId: () => store.allocateAgentIdForLifecycleCoordinator(),
				now: () => new Date().toISOString(),
				processIdentity: testProcessIdentity("pyrun-retained-db"),
				sessionPath,
			});
			const lifecycle = createDetachedJobLifecycleController({
				artifactRoot: root,
				controlDbPath,
				coordinator,
				ownerSessionId: "main",
				sessionPath,
				store,
			});
			const jobId = lifecycle.allocateJobId("pyrun");
			const artifacts = lifecycle.createArtifacts(jobId);
			const activationPath = join(artifacts.directory, "activation.json");
			const manifestPath = join(artifacts.directory, "launch.json");
			const runnerPid = launchDetachedPyrunRunner(manifestPath, {
				entryPath: join(import.meta.dirname, "../extensions/pyrun/src/detached-runner-entry.ts"),
			});
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(existsSync(`${manifestPath}.runner-error`)).toBe(false);
			const ownership = lifecycle.register({
				agentType: "pyrun",
				cwd: root,
				displayName: "Pyrun retained database connection",
				jobId,
				processIdentity: readProcessIdentity(runnerPid),
				workerHandleId: String(runnerPid),
			});
			const supervisorAddress = { agentId: null, sessionId: "main" };
			registerRuntimeMailboxListener(controlDbPath, supervisorAddress, process.pid, sessionPath);
			writeDetachedPyrunLaunchManifest(manifestPath, {
				activationPath,
				artifacts,
				bridgeRequestPath: join(artifacts.directory, "foreground-bridge-requests.jsonl"),
				bridgeResponsePath: join(artifacts.directory, "foreground-bridge-responses.jsonl"),
				controlDbPath,
				foregroundCompletionPath: join(artifacts.directory, "foreground-completed"),
				params: { code: "6 * 7" },
				runnerAddress: { agentId: jobId, sessionId: "main" },
				runnerOptions: { command: runnerPath, inheritEnv: true },
				runnerProcessIdentity: readProcessIdentity(runnerPid),
				sessionPath,
				startedAt: Date.now() - 1_000,
				supervisorProcessIdentity: readProcessIdentity(process.pid),
				toolCallId: "test-pyrun-retained-db",
			});
			writeDetachedPyrunActivation(activationPath, ownership.identity);

			await waitFor(() => {
				if (existsSync(`${manifestPath}.runner-error`)) {
					throw new Error(readFileSync(`${manifestPath}.runner-error`, "utf8"));
				}
				return (
					existsSync(artifacts.outputPath) &&
					readFileSync(artifacts.outputPath, "utf8").includes('"kind":"progress"')
				);
			});
			let stableDescriptors: Record<string, string> | undefined;
			await waitFor(() => {
				const descriptors = readOpenControlDbDescriptors(runnerPid, controlDbPath);
				if (
					descriptors[controlDbPath] &&
					descriptors[`${controlDbPath}-wal`] &&
					descriptors[`${controlDbPath}-shm`]
				) {
					stableDescriptors = descriptors;
					return true;
				}
				return false;
			});
			if (!stableDescriptors) throw new Error("Expected open control database descriptors");

			const samples: Array<Record<string, string>> = [];
			for (let sample = 0; sample < 40; sample += 1) {
				samples.push(readOpenControlDbDescriptors(runnerPid, controlDbPath));
				await new Promise((resolve) => setTimeout(resolve, 5));
			}

			await requestAndAssertDetachedPyrunStatus({
				controlDbPath,
				expectedOutputPath: artifacts.outputPath,
				identity: ownership.identity,
				requestId: "status-1",
				requesterAddress: supervisorAddress,
				runnerAddress: { agentId: jobId, sessionId: "main" },
				sessionPath,
			});
			await requestAndAssertDetachedPyrunStatus({
				controlDbPath,
				expectedOutputPath: artifacts.outputPath,
				identity: ownership.identity,
				requestId: "status-2",
				requesterAddress: supervisorAddress,
				runnerAddress: { agentId: jobId, sessionId: "main" },
				sessionPath,
			});

			await waitFor(() => {
				const agent = readMultiAgentState(controlDbPath, sessionPath)?.agents[0] as
					| { lifecycle?: unknown }
					| undefined;
				return agent?.lifecycle === "completed";
			});
			await waitFor(() => !existsSync(`/proc/${runnerPid}`));
			expect(readOpenControlDbDescriptors(runnerPid, controlDbPath)).toEqual({});
			expect(samples).toEqual(samples.map(() => stableDescriptors));
		},
	);

	it.runIf(process.platform === "linux")(
		"kills the nested Pyrun runner and its child when a durable evaluation is cancelled",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "pi-detached-pyrun-cancel-tree-"));
			temporaryDirectories.push(root);
			const childPidPath = join(root, "child.pid");
			const nestedRunnerPidPath = join(root, "nested-runner.pid");
			const nestedRunnerPath = join(root, "nested-pyrun.mjs");
			writeFileSync(
				nestedRunnerPath,
				[
					"#!/usr/bin/env node",
					"import { spawn } from 'node:child_process';",
					"import { writeFileSync } from 'node:fs';",
					"writeFileSync(process.env.NESTED_RUNNER_PID_PATH, String(process.pid));",
					"let started = false;",
					"process.stdin.on('data', () => {",
					"  if (started) return;",
					"  started = true;",
					"  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
					"  writeFileSync(process.env.CHILD_PID_PATH, String(child.pid));",
					"  process.stdout.write(JSON.stringify({ type: 'progress', message: 'child started' }) + '\\n');",
					"});",
					"setInterval(() => {}, 1000);",
				].join("\n"),
			);
			chmodSync(nestedRunnerPath, 0o700);
			const controlDbPath = join(root, "control.sqlite");
			const sessionPath = join(root, "session.jsonl");
			const runnerAddress = { agentId: "pyrun_1", sessionId: "main" };
			const store = new MultiAgentStore();
			const coordinator = new LifecycleCoordinator({
				controlDbPath,
				createAgentId: () => runnerAddress.agentId,
				now: () => new Date().toISOString(),
				processIdentity: testProcessIdentity("pyrun-cancel-tree"),
				sessionPath,
			});
			const lifecycle = createDetachedJobLifecycleController({
				artifactRoot: root,
				controlDbPath,
				coordinator,
				ownerSessionId: runnerAddress.sessionId,
				sessionPath,
				store,
			});
			const artifacts = lifecycle.createArtifacts(runnerAddress.agentId);
			const activationPath = join(artifacts.directory, "activation.json");
			const manifestPath = join(artifacts.directory, "launch.json");
			const durableRunnerPid = launchDetachedPyrunRunner(manifestPath, {
				entryPath: join(import.meta.dirname, "../extensions/pyrun/src/detached-runner-entry.ts"),
			});
			let childPid = 0;
			let nestedRunnerPid = 0;
			try {
				const durableRunnerIdentity = readProcessIdentity(durableRunnerPid);
				const ownership = lifecycle.register({
					agentType: "pyrun",
					cwd: root,
					displayName: "Pyrun cancellation tree",
					jobId: runnerAddress.agentId,
					processIdentity: durableRunnerIdentity,
					workerHandleId: String(durableRunnerPid),
				});
				writeDetachedPyrunLaunchManifest(manifestPath, {
					activationPath,
					artifacts,
					bridgeRequestPath: join(artifacts.directory, "foreground-bridge-requests.jsonl"),
					bridgeResponsePath: join(artifacts.directory, "foreground-bridge-responses.jsonl"),
					controlDbPath,
					foregroundCompletionPath: join(artifacts.directory, "foreground-completed"),
					params: { code: "run child forever" },
					runnerAddress,
					runnerOptions: {
						args: [nestedRunnerPath],
						command: process.execPath,
						env: { CHILD_PID_PATH: childPidPath, NESTED_RUNNER_PID_PATH: nestedRunnerPidPath },
						inheritEnv: true,
					},
					runnerProcessIdentity: durableRunnerIdentity,
					sessionPath,
					startedAt: Date.now(),
					supervisorProcessIdentity: readProcessIdentity(process.pid),
					toolCallId: "test-pyrun-cancel-tree",
				});
				writeDetachedPyrunActivation(activationPath, ownership.identity);
				await waitFor(() => existsSync(childPidPath) && existsSync(nestedRunnerPidPath));
				childPid = Number(readFileSync(childPidPath, "utf8"));
				nestedRunnerPid = Number(readFileSync(nestedRunnerPidPath, "utf8"));

				const cancelling = coordinator.requestDetachedCancellation({
					agent: ownership.agent,
					outputLabel: artifacts.outputPath,
					ownership: ownership.controlOwnership,
					reason: "test cancellation",
				});
				expect(cancelling.ok).toBe(true);
				if (!cancelling.ok) return;
				upsertMultiAgentMailboxMessage(controlDbPath, sessionPath, "message_1", {
					body: JSON.stringify({ command: "cancel", identity: ownership.identity, reason: "test cancellation" }),
					fromAgentId: "main",
					id: "message_1",
					kind: "system",
					status: "pending",
					toAgentId: runnerAddress.agentId,
				});
				enqueueRuntimeMailboxMessage(controlDbPath, {
					kind: "system",
					recipient: runnerAddress,
					sender: { agentId: null, sessionId: runnerAddress.sessionId },
					storeRef: { messageId: "message_1", sessionPath },
				});

				await waitFor(
					() => readMultiAgentAgent(controlDbPath, sessionPath, runnerAddress.agentId)?.lifecycle === "aborted",
				);
				await waitFor(() => !processIsAlive(durableRunnerPid) && !processIsAlive(nestedRunnerPid));
				expect(processIsAlive(childPid)).toBe(false);
			} finally {
				terminateProcessGroup(durableRunnerPid);
				terminateProcess(nestedRunnerPid);
				terminateProcess(childPid);
			}
		},
	);
});

async function requestAndAssertDetachedPyrunStatus(input: {
	controlDbPath: string;
	expectedOutputPath: string;
	identity: DetachedJobOwnershipIdentity;
	requestId: string;
	requesterAddress: { agentId: string | null; sessionId: string };
	runnerAddress: { agentId: string | null; sessionId: string };
	sessionPath: string;
}): Promise<void> {
	enqueueDetachedJobStatusRequest({
		controlDbPath: input.controlDbPath,
		identity: input.identity,
		requesterAddress: input.requesterAddress,
		requestId: input.requestId,
		runnerAddress: input.runnerAddress,
		sessionPath: input.sessionPath,
	});
	await waitFor(() =>
		listRuntimeMailboxMessages(input.controlDbPath).some((message) => {
			if (
				message.recipient.agentId !== null ||
				message.recipient.sessionId !== input.requesterAddress.sessionId ||
				message.status !== "pending"
			) {
				return false;
			}
			try {
				const body = JSON.parse(message.body) as { command?: unknown; requestId?: unknown };
				return body.command === "respond" && body.requestId === input.requestId;
			} catch {
				return false;
			}
		}),
	);
	const responses = claimRuntimeMailboxMessages(input.controlDbPath, input.requesterAddress);
	if (responses.length !== 1) throw new Error(`Expected one response for ${input.requestId}`);
	const response = responses[0];
	if (!response) throw new Error(`Missing response for ${input.requestId}`);
	const body = JSON.parse(response.body) as {
		command?: unknown;
		identity?: unknown;
		requestId?: unknown;
		result?: { outputPath?: unknown; pendingRequestCount?: unknown; state?: unknown };
	};
	expect(body.command).toBe("respond");
	expect(body.requestId).toBe(input.requestId);
	expect(body.identity).toEqual(input.identity);
	expect(body.result).toEqual({
		outputPath: input.expectedOutputPath,
		pendingRequestCount: 0,
		state: "running",
	});
	expect(
		listRuntimeMailboxMessages(input.controlDbPath).filter((message) => message.status === "pending"),
	).toHaveLength(0);
}

function readOpenControlDbDescriptors(pid: number, controlDbPath: string): Record<string, string> {
	const targets = new Set([controlDbPath, `${controlDbPath}-wal`, `${controlDbPath}-shm`]);
	const descriptors: Record<string, string> = {};
	let entries: string[];
	try {
		entries = readdirSync(`/proc/${pid}/fd`);
	} catch {
		return descriptors;
	}
	for (const descriptor of entries) {
		let target: string;
		try {
			target = readlinkSync(`/proc/${pid}/fd/${descriptor}`);
		} catch {
			continue;
		}
		if (targets.has(target)) descriptors[target] = descriptor;
	}
	return descriptors;
}

function processIsAlive(pid: number): boolean {
	if (pid === 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function terminateProcess(pid: number): void {
	if (!processIsAlive(pid)) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

function terminateProcessGroup(pid: number): void {
	if (pid === 0) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for detached Pyrun runner state");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
