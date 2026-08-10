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
import { createDetachedJobLifecycleController } from "../src/core/detached-job-lifecycle.ts";
import { LifecycleCoordinator } from "../src/core/lifecycle-coordinator.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { readProcessIdentity } from "../src/core/runtime-process.ts";
import {
	claimRuntimeMailboxMessages,
	listRuntimeMailboxMessages,
	readMultiAgentState,
	registerRuntimeMailboxListener,
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
});

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

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for detached Pyrun runner state");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
