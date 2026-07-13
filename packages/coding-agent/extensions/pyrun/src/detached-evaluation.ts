import { closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { AgentToolResult, ExtensionContext } from "../../../src/core/extensions/types.ts";
import { finalizeDetachedJobWithRetry } from "../../../src/core/detached-bash-runner.ts";
import { createDetachedJobLifecycleController } from "../../../src/core/detached-job-lifecycle.ts";
import { createDetachedJobTerminalInput } from "../../../src/core/detached-job-runner.ts";
import { LifecycleCoordinator } from "../../../src/core/lifecycle-coordinator.ts";
import { isActiveLifecycle, type AgentSnapshot, type MultiAgentStore } from "../../../src/core/multi-agent-store.ts";
import { isProcessIdentityAlive, readProcessIdentity } from "../../../src/core/runtime-process.ts";
import { finalizeDetachedJob, readMultiAgentAgent } from "../../../src/core/session-control-db.ts";
import type { ToolDetachRegistry } from "../../../src/core/tool-detach-registry.ts";
import {
	createCanonicalPyrunEvalParams,
	createPyrunProgressReporter,
	formatCanonicalPyrunEvalResult,
	type PyrunEvalParams,
	type PyrunPiRequestDispatcher,
} from "./eval-tool.ts";
import {
	launchDetachedPyrunRunner,
	readDetachedPyrunActivation,
	readDetachedPyrunLaunchManifest,
	writeDetachedPyrunActivation,
	writeDetachedPyrunLaunchManifest,
} from "./detached-runner.ts";
import type { CanonicalPyrunEvalResult, CanonicalPyrunProgressUpdate, PyrunRunnerOptions } from "./runner.ts";

const ARTIFACT_POLL_MS = 25;

export async function runDurableDetachablePyrunEvaluation(input: {
	ctx: ExtensionContext;
	detachRegistry: ToolDetachRegistry;
	dispatchPiRequest: PyrunPiRequestDispatcher;
	onUpdate?: (partial: AgentToolResult<CanonicalPyrunEvalResult | CanonicalPyrunProgressUpdate>) => void;
	params: PyrunEvalParams;
	piBridgeEnabled: boolean;
	toolCallId: string;
	runnerOptions: PyrunRunnerOptions;
	signal?: AbortSignal;
	store: MultiAgentStore;
	writeActivation?: typeof writeDetachedPyrunActivation;
}): Promise<AgentToolResult<unknown>> {
	const startedAt = input.ctx.toolExecutionStartedAt;
	if (startedAt === undefined) {
		throw new Error("Detached Pyrun requires the tool lifecycle start timestamp");
	}
	const persistence = input.store.getPersistenceTarget();
	if (!persistence) throw new Error("Detached Pyrun requires a persisted supervisor session");
	const controller = createPyrunLifecycleController(input, persistence);
	const restored = await restoreForegroundPyrunRunner(input, persistence);
	if (restored?.kind === "aborted") return formatTerminalAgentError(input.params, restored.agent);
	const runner = restored?.runner ?? launchForegroundPyrunRunner(input, persistence, controller, startedAt);
	return observeDetachablePyrunEvaluation({ ...input, controller, runner });
}

function createPyrunLifecycleController(
	input: Parameters<typeof runDurableDetachablePyrunEvaluation>[0],
	persistence: NonNullable<ReturnType<MultiAgentStore["getPersistenceTarget"]>>,
) {
	return createDetachedJobLifecycleController({
		artifactRoot: dirname(persistence.sessionPath),
		controlDbPath: persistence.controlDbPath,
		coordinator: new LifecycleCoordinator({
			controlDbPath: persistence.controlDbPath,
			createAgentId: () => input.store.allocateAgentIdForLifecycleCoordinator(),
			now: () => new Date().toISOString(),
			processIdentity: readProcessIdentity(process.pid),
			sessionPath: persistence.sessionPath,
		}),
		ownerAgentId: input.ctx.multiAgentAgentId,
		ownerSessionId: input.ctx.sessionManager.getSessionId(),
		sessionPath: persistence.sessionPath,
		store: input.store,
	});
}

function pyrunArtifactRoot(sessionPath: string): string {
	const sessionFileName = basename(sessionPath);
	const sessionName = sessionFileName.slice(0, sessionFileName.length - extname(sessionFileName).length);
	if (!sessionName) throw new Error("Pyrun session path must have a file name");
	return join(dirname(sessionPath), "detached-jobs", sessionName);
}

type RestoredPyrunRunner = ReturnType<typeof launchForegroundPyrunRunner>;

type PyrunResumeDecision =
	| { kind: "resume"; runner: RestoredPyrunRunner }
	| { kind: "aborted"; agent: AgentSnapshot };

async function restoreForegroundPyrunRunner(
	input: Parameters<typeof runDurableDetachablePyrunEvaluation>[0],
	persistence: NonNullable<ReturnType<MultiAgentStore["getPersistenceTarget"]>>,
): Promise<PyrunResumeDecision | undefined> {
	const artifactRoot = pyrunArtifactRoot(persistence.sessionPath);
	if (!existsSync(artifactRoot)) return undefined;
	const expectedParams = createCanonicalPyrunEvalParams(input.params, input.ctx, input.piBridgeEnabled);
	for (const entry of readdirSync(artifactRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const directory = join(artifactRoot, entry.name);
		const manifestPath = join(directory, "launch.json");
		if (!existsSync(manifestPath)) continue;
		let manifest: ReturnType<typeof readDetachedPyrunLaunchManifest>;
		try {
			manifest = readDetachedPyrunLaunchManifest(manifestPath);
		} catch {
			continue;
		}
		const jobId = manifest.runnerAddress.agentId;
		if (!jobId) throw new Error(`Pyrun launch manifest has no job ID: ${manifestPath}`);
		// Manifests written before tool-call correlation existed carry no toolCallId and
		// cannot be matched to the replayed call. A job whose cancellation was requested
		// but never settled (e.g. its runtime died mid-cancel) must not be resumed on
		// session reload, whether we can correlate it or not. For both cases, honor the
		// cancellation: kill any surviving runner and settle the job to aborted.
		const missingToolCallId = manifest.toolCallId == null;
		const matchesCall = !missingToolCallId && manifest.toolCallId === input.toolCallId;
		if (missingToolCallId || matchesCall) {
			const persisted = readMultiAgentAgent(persistence.controlDbPath, persistence.sessionPath, jobId);
			if (persisted?.lifecycle === "cancelling") {
				return { kind: "aborted", agent: await settleCancellingPyrunJob(persistence, manifest, persisted) };
			}
		}
		if (!matchesCall) continue;
		if (JSON.stringify(manifest.params) !== JSON.stringify(expectedParams)) {
			throw new Error(`Pyrun tool-call artifact collision for ${input.toolCallId}`);
		}
		if (!isProcessIdentityAlive(manifest.runnerProcessIdentity)) {
			rmSync(directory, { recursive: true, force: true });
			return undefined;
		}
		return {
			kind: "resume",
			runner: {
				activationPath: manifest.activationPath,
				artifacts: manifest.artifacts,
				bridgeRequestPath: manifest.bridgeRequestPath,
				bridgeResponsePath: manifest.bridgeResponsePath,
				foregroundCompletionPath: manifest.foregroundCompletionPath,
				jobId,
				processIdentity: manifest.runnerProcessIdentity,
				runnerPid: manifest.runnerProcessIdentity.pid,
			},
		};
	}
	return undefined;
}

/**
 * Settles a detached Pyrun job whose persisted lifecycle is `cancelling` to
 * `aborted` without re-running it. Kills any surviving runner to enforce the
 * cancellation, then commits the terminal transition through the same finalize
 * path the detached runner would have used. Returns the terminal agent snapshot;
 * falls back to the persisted `cancelling` snapshot if the job's ownership can no
 * longer be matched (already released/recovered elsewhere).
 */
async function settleCancellingPyrunJob(
	persistence: NonNullable<ReturnType<MultiAgentStore["getPersistenceTarget"]>>,
	manifest: ReturnType<typeof readDetachedPyrunLaunchManifest>,
	persisted: AgentSnapshot,
): Promise<AgentSnapshot> {
	if (isProcessIdentityAlive(manifest.runnerProcessIdentity)) {
		terminateForegroundRunner(manifest.runnerProcessIdentity.pid, "SIGKILL");
	}
	const identity = readDetachedPyrunActivation(manifest.activationPath);
	if (!identity) return persisted;
	// The runner may have died before writing any output; the terminal input hashes
	// the output file, so ensure it exists before building the aborted transition.
	if (!existsSync(manifest.artifacts.outputPath)) {
		closeSync(openSync(manifest.artifacts.outputPath, "a", 0o600));
	}
	const terminalAt = Date.now();
	const terminal = createDetachedJobTerminalInput(
		manifest.artifacts,
		identity,
		{ kind: "aborted", reason: "Cancelled before session resume" },
		new Date(terminalAt).toISOString(),
		Math.max(0, terminalAt - manifest.startedAt),
		manifest.toolCallId,
	);
	const finalized = await finalizeDetachedJobWithRetry(terminal, (terminalInput) =>
		finalizeDetachedJob(persistence.controlDbPath, { sessionPath: persistence.sessionPath, terminal: terminalInput }),
	);
	if (finalized.ok) return finalized.terminalAgent;
	return readMultiAgentAgent(persistence.controlDbPath, persistence.sessionPath, persisted.id) ?? persisted;
}

function launchForegroundPyrunRunner(
	input: Parameters<typeof runDurableDetachablePyrunEvaluation>[0],
	persistence: NonNullable<ReturnType<MultiAgentStore["getPersistenceTarget"]>>,
	controller: ReturnType<typeof createDetachedJobLifecycleController>,
	startedAt: number,
) {
	const jobId = controller.allocateJobId("pyrun");
	const artifacts = controller.createArtifacts(jobId);
	const activationPath = join(artifacts.directory, "activation.json");
	const bridgeRequestPath = join(artifacts.directory, "foreground-bridge-requests.jsonl");
	const bridgeResponsePath = join(artifacts.directory, "foreground-bridge-responses.jsonl");
	const foregroundCompletionPath = join(artifacts.directory, "foreground-completed");
	const manifestPath = join(artifacts.directory, "launch.json");
	const runnerPid = launchDetachedPyrunRunner(manifestPath);
	const processIdentity = readProcessIdentity(runnerPid);
	writeDetachedPyrunLaunchManifest(manifestPath, {
		activationPath,
		artifacts,
		bridgeRequestPath,
		bridgeResponsePath,
		controlDbPath: persistence.controlDbPath,
		foregroundCompletionPath,
		params: createCanonicalPyrunEvalParams(input.params, input.ctx, input.piBridgeEnabled),
		runnerAddress: { agentId: jobId, sessionId: input.ctx.sessionManager.getSessionId() },
		runnerOptions: input.runnerOptions,
		runnerProcessIdentity: processIdentity,
		sessionPath: persistence.sessionPath,
		startedAt,
		supervisorProcessIdentity: readProcessIdentity(process.pid),
		toolCallId: input.toolCallId,
	});
	return {
		activationPath,
		artifacts,
		bridgeRequestPath,
		bridgeResponsePath,
		foregroundCompletionPath,
		jobId,
		processIdentity,
		runnerPid,
	};
}

type DetachablePyrunInput = Parameters<typeof runDurableDetachablePyrunEvaluation>[0] & {
	controller: ReturnType<typeof createDetachedJobLifecycleController>;
	runner: ReturnType<typeof launchForegroundPyrunRunner>;
};

type PyrunOwnership = ReturnType<ReturnType<typeof createDetachedJobLifecycleController>["register"]>;

function createPyrunDetachControl(input: DetachablePyrunInput): {
	cancel: () => void;
	detach: () => boolean;
	getOwnership: () => PyrunOwnership | undefined;
	isActivated: () => boolean;
} {
	let activated = false;
	let ownership: PyrunOwnership | undefined;
	return {
		cancel: () => {
			if (ownership) input.controller.cancel(ownership, "Pyrun tool call aborted");
			else terminateForegroundRunner(input.runner.runnerPid);
		},
		detach: () => {
			if (ownership || !isProcessIdentityAlive(input.runner.processIdentity)) return false;
			ownership = input.controller.register({
				agentType: "pyrun",
				cwd: input.ctx.cwd,
				displayName: "Pyrun evaluation",
				jobId: input.runner.jobId,
				processIdentity: input.runner.processIdentity,
				workerHandleId: String(input.runner.runnerPid),
				toolCallId: input.toolCallId,
			});
			try {
				(input.writeActivation ?? writeDetachedPyrunActivation)(input.runner.activationPath, ownership.identity);
				activated = true;
				return true;
			} catch {
				terminateForegroundRunner(input.runner.runnerPid, "SIGKILL");
				return false;
			}
		},
		getOwnership: () => ownership,
		isActivated: () => activated,
	};
}

async function observeDetachablePyrunEvaluation(input: DetachablePyrunInput): Promise<AgentToolResult<unknown>> {
	let bridgeRequestOffset = 0;
	let outputOffset = 0;
	let result: CanonicalPyrunEvalResult | undefined;
	let terminalAgent: AgentSnapshot | undefined;
	const reportProgress = createPyrunProgressReporter(input.onUpdate);
	const control = createPyrunDetachControl(input);
	const unregister = input.detachRegistry.register({ detach: control.detach });
	const cancel = control.cancel;
	input.signal?.addEventListener("abort", cancel, { once: true });
	try {
		for (;;) {
			bridgeRequestOffset = await respondToPendingForegroundBridgeRequests(
				input,
				bridgeRequestOffset,
				control.getOwnership() !== undefined,
			);
			const records = readNewArtifactRecords(input.runner.artifacts.outputPath, outputOffset);
			outputOffset = records.offset;
			result = consumeArtifactRecords(records.values, reportProgress) ?? result;
			const ownership = control.getOwnership();
			const foregroundError = records.values.find((record) => record.kind === "error");
			if (!ownership && foregroundError) {
				writeFileSync(input.runner.foregroundCompletionPath, "failed\n", { encoding: "utf8", mode: 0o600 });
				throw new Error(foregroundError.error);
			}
			if (!ownership && result) {
				writeFileSync(input.runner.foregroundCompletionPath, "completed\n", { encoding: "utf8", mode: 0o600 });
				return formatCanonicalPyrunEvalResult(input.params, result);
			}
			if (!ownership && !isProcessIdentityAlive(input.runner.processIdentity)) {
				throw new Error("Foreground Pyrun runner exited without producing a result");
			}
			if (ownership) terminalAgent = input.controller.observe(ownership.agent.id);
			if (terminalAgent && !isActiveLifecycle(terminalAgent.lifecycle)) break;
			if (ownership && control.isActivated()) {
				return detachedResult(input.params, ownership.agent.id, ownership.artifacts.outputPath);
			}
			await new Promise((resolve) => setTimeout(resolve, ARTIFACT_POLL_MS));
		}
		if (result) return formatCanonicalPyrunEvalResult(input.params, result);
		if (!terminalAgent) throw new Error("Detached Pyrun job terminal state is unavailable");
		return formatTerminalAgentError(input.params, terminalAgent);
	} finally {
		unregister();
		input.signal?.removeEventListener("abort", cancel);
	}
}

async function respondToPendingForegroundBridgeRequests(
	input: DetachablePyrunInput,
	offset: number,
	detached: boolean,
): Promise<number> {
	if (detached) return offset;
	const requests = readNewJsonLines<ForegroundBridgeRequest>(input.runner.bridgeRequestPath, offset);
	for (const request of requests.values) await respondToForegroundBridgeRequest(input, request);
	return requests.offset;
}

interface ForegroundBridgeRequest {
	method: string;
	params: unknown;
	requestId: string;
}

async function respondToForegroundBridgeRequest(
	input: DetachablePyrunInput,
	request: ForegroundBridgeRequest,
): Promise<void> {
	if (!claimForegroundBridgeRequest(input.runner.artifacts.directory, request.requestId)) return;
	appendJsonLine(input.runner.bridgeResponsePath, { claimed: true, requestId: request.requestId });
	try {
		const result = await input.dispatchPiRequest(
			{ method: request.method, params: request.params },
			input.ctx,
			input.signal,
		);
		appendJsonLine(input.runner.bridgeResponsePath, { requestId: request.requestId, result });
	} catch (error) {
		appendJsonLine(input.runner.bridgeResponsePath, {
			error: error instanceof Error ? error.message : String(error),
			requestId: request.requestId,
		});
	}
}

function claimForegroundBridgeRequest(directory: string, requestId: string): boolean {
	try {
		closeSync(openSync(join(directory, `bridge-claim-${requestId}`), "wx", 0o600));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

function appendJsonLine(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "a", mode: 0o600 });
}

function terminateForegroundRunner(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
	try {
		process.kill(-pid, signal);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
	try {
		process.kill(pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

function consumeArtifactRecords(
	records: ReturnType<typeof readNewArtifactRecords>["values"],
	reportProgress: (update: CanonicalPyrunProgressUpdate) => void,
): CanonicalPyrunEvalResult | undefined {
	let result: CanonicalPyrunEvalResult | undefined;
	for (const record of records) {
		if (record.kind === "progress") reportProgress(record.update);
		else if (record.kind === "result") result = record.result;
	}
	return result;
}

function formatTerminalAgentError(params: PyrunEvalParams, agent: AgentSnapshot): AgentToolResult<unknown> {
	const error = agent.error?.message ?? agent.result?.summary ?? `Pyrun evaluation ${agent.lifecycle}`;
	return {
		content: [{ type: "text", text: `${params.code}\n\nError: ${error}` }],
		details: { error, executed: params.code, type: "error" },
		isError: true,
	};
}

function readNewJsonLines<T>(path: string, offset: number): { offset: number; values: T[] } {
	if (!existsSync(path)) return { offset, values: [] };
	const data = readFileSync(path);
	if (data.length <= offset) return { offset, values: [] };
	const text = data.subarray(offset).toString("utf8");
	const values = text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as T);
	return { offset: data.length, values };
}

function readNewArtifactRecords(path: string, offset: number): {
	offset: number;
	values: Array<
		| { error: string; kind: "error" }
		| { kind: "progress"; update: CanonicalPyrunProgressUpdate }
		| { kind: "result"; result: CanonicalPyrunEvalResult }
	>;
} {
	return readNewJsonLines<ReturnType<typeof readNewArtifactRecords>["values"][number]>(path, offset);
}

function detachedResult(params: PyrunEvalParams, jobId: string, logPath: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: `${params.code}\n\nPyrun evaluation moved to background as job ${jobId}. Output will be written to ${logPath}.` }],
		details: { backgroundJobId: jobId, executed: params.code, type: "detached" },
	};
}
