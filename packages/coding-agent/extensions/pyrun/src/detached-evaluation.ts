import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { finalizeDetachedJobWithRetry } from "../../../src/core/detached-bash-runner.ts";
import { createDetachedJobLifecycleController } from "../../../src/core/detached-job-lifecycle.ts";
import { createDetachedJobTerminalInput } from "../../../src/core/detached-job-runner.ts";
import type { AgentToolResult, ExtensionContext } from "../../../src/core/extensions/types.ts";
import { LifecycleCoordinator } from "../../../src/core/lifecycle-coordinator.ts";
import { type AgentSnapshot, isActiveLifecycle, type MultiAgentStore } from "../../../src/core/multi-agent-store.ts";
import {
	isProcessIdentityAlive,
	type ProcessIdentity,
	readProcessIdentity,
} from "../../../src/core/runtime-process.ts";
import { finalizeDetachedJob, readMultiAgentAgent } from "../../../src/core/session-control-db.ts";
import type { ToolDetachRegistry } from "../../../src/core/tool-detach-registry.ts";

import {
	ARTIFACT_POLL_MS,
	createArtifactWakeup,
	createJsonLineReadCursor,
	type JsonLineReadCursor,
	type JsonLineReadResult,
	readNewArtifactRecords,
	readNewJsonLines,
	waitForArtifactActivity,
} from "./detached-evaluation-artifacts.ts";
import { createArtifactProgressAccumulator, type PyrunArtifactRecord } from "./detached-progress.ts";
import {
	launchDetachedPyrunRunner,
	readDetachedPyrunActivation,
	readDetachedPyrunLaunchManifest,
	writeDetachedPyrunActivation,
	writeDetachedPyrunLaunchManifest,
} from "./detached-runner.ts";
import {
	createCanonicalPyrunEvalParams,
	createPyrunProgressReporter,
	formatCanonicalPyrunEvalResult,
	formatStreamedPyrunEvalResult,
	type PyrunEvalParams,
	type PyrunPiRequestDispatcher,
	type PyrunProgressReporter,
	withStreamedConsole,
} from "./eval-tool.ts";
import type { CanonicalPyrunEvalResult, CanonicalPyrunProgressUpdate, PyrunRunnerOptions } from "./runner.ts";
import { ensurePyrunSessionProxy } from "./session-proxy.ts";

const FOREGROUND_RUNNER_LIVENESS_POLL_MS = 3_000;

export async function runDurableDetachablePyrunEvaluation(input: {
	agentId: string;
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
	if (restored?.kind === "terminal") return formatPyrunArtifactResult(input.params, restored.result, restored.records);
	if (restored?.kind === "lost_runtime") {
		return formatLostPyrunRuntime(input.params, restored.records, restored.outputPath);
	}
	if (restored?.kind === "resume")
		return observeDetachablePyrunEvaluation({ ...input, controller, runner: restored.runner });
	const proxySocket = await ensureSessionProxy(input);
	// The abort listener is registered only while the runner is observed, so an earlier abort must stop the launch.
	if (input.signal?.aborted) throw new Error("Pyrun tool call aborted");
	const runner = launchForegroundPyrunRunner(input, persistence, controller, startedAt, proxySocket);
	return observeDetachablePyrunEvaluation({ ...input, controller, runner });
}

/** A named Pyrun session keeps one Python, and so its ctx, across calls; unnamed calls get a fresh Python. */
async function ensureSessionProxy(
	input: Parameters<typeof runDurableDetachablePyrunEvaluation>[0],
): Promise<string | undefined> {
	if (!input.params.session_id) return undefined;
	const sessionPath = input.store.getPersistenceTarget()?.sessionPath;
	if (!sessionPath) throw new Error("Pyrun session proxy requires a persisted session");
	return ensurePyrunSessionProxy({ runnerOptions: input.runnerOptions, sessionPath });
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
type PyrunLaunchManifest = ReturnType<typeof readDetachedPyrunLaunchManifest>;

type PyrunResumeDecision =
	| { kind: "resume"; runner: RestoredPyrunRunner }
	| { kind: "aborted"; agent: AgentSnapshot }
	| { kind: "terminal"; records: PyrunArtifactRecord[]; result: CanonicalPyrunEvalResult }
	| { kind: "lost_runtime"; outputPath: string; records: PyrunArtifactRecord[] };

const EMPTY_PYRUN_RUNNER_ERROR = "Pyrun runner failed without diagnostic output.";

interface PyrunManifestCandidate {
	directory: string;
	manifest: PyrunLaunchManifest;
	manifestPath: string;
}

function readPyrunManifestCandidate(directory: string): PyrunManifestCandidate | undefined {
	const manifestPath = join(directory, "launch.json");
	if (!existsSync(manifestPath)) return undefined;
	return { directory, manifest: readDetachedPyrunLaunchManifest(manifestPath), manifestPath };
}

async function settleCancelledPyrunCandidate(
	persistence: NonNullable<ReturnType<MultiAgentStore["getPersistenceTarget"]>>,
	candidate: PyrunManifestCandidate,
	toolCallId: string,
	jobId: string,
): Promise<PyrunResumeDecision | undefined> {
	const correlated = candidate.manifest.toolCallId == null || candidate.manifest.toolCallId === toolCallId;
	if (!correlated) return undefined;
	const persisted = readMultiAgentAgent(persistence.controlDbPath, persistence.sessionPath, jobId);
	if (persisted?.lifecycle !== "cancelling") return undefined;
	return { kind: "aborted", agent: await settleCancellingPyrunJob(persistence, candidate.manifest, persisted) };
}

function restorePyrunCandidate(
	candidate: PyrunManifestCandidate,
	expectedParams: ReturnType<typeof createCanonicalPyrunEvalParams>,
	toolCallId: string,
	jobId: string,
): PyrunResumeDecision | undefined {
	const { directory, manifest } = candidate;
	// The Pi capability snapshot (context usage, git branch, model) changes between launch and replay.
	const callIdentity = (params: object) => JSON.stringify({ ...params, pi: undefined });
	if (callIdentity(manifest.params) !== callIdentity(expectedParams)) {
		throw new Error(`Pyrun tool-call artifact collision for ${toolCallId}`);
	}
	const records = readCompletePyrunArtifactRecords(manifest.artifacts.outputPath);
	const terminalResult = restoreTerminalPyrunResult(records);
	if (terminalResult) return { kind: "terminal", records, result: terminalResult };
	const runnerError = readForegroundPyrunRunnerError(candidate.manifestPath, manifest.activationPath);
	if (runnerError !== undefined) {
		failForegroundPyrunRunner(runnerError, manifest.foregroundCompletionPath, manifest.runnerProcessIdentity);
	}
	if (!isProcessIdentityAlive(manifest.runnerProcessIdentity)) {
		return { kind: "lost_runtime", outputPath: manifest.artifacts.outputPath, records };
	}
	const scriptPath = join(directory, "script.py");
	if (!existsSync(scriptPath)) throw new Error(`Pyrun script artifact is missing: ${scriptPath}`);
	return { kind: "resume", runner: buildRestoredPyrunRunner(candidate, jobId, scriptPath) };
}

function buildRestoredPyrunRunner(
	candidate: PyrunManifestCandidate,
	jobId: string,
	scriptPath: string,
): RestoredPyrunRunner {
	const { manifest, manifestPath } = candidate;
	return {
		activationPath: manifest.activationPath,
		artifacts: manifest.artifacts,
		bridgeRequestPath: manifest.bridgeRequestPath,
		bridgeResponsePath: manifest.bridgeResponsePath,
		foregroundCompletionPath: manifest.foregroundCompletionPath,
		jobId,
		manifestPath,
		processIdentity: manifest.runnerProcessIdentity,
		runnerPid: manifest.runnerProcessIdentity.pid,
		scriptPath,
	};
}

async function restoreForegroundPyrunRunner(
	input: Parameters<typeof runDurableDetachablePyrunEvaluation>[0],
	persistence: NonNullable<ReturnType<MultiAgentStore["getPersistenceTarget"]>>,
): Promise<PyrunResumeDecision | undefined> {
	const directory = join(pyrunArtifactRoot(persistence.sessionPath), input.agentId);
	const candidate = readPyrunManifestCandidate(directory);
	if (!candidate) return undefined;
	const manifestAgentId = candidate.manifest.runnerAddress.agentId;
	if (manifestAgentId !== input.agentId) {
		throw new Error(`Pyrun launch manifest agent ID mismatch: ${candidate.manifestPath}`);
	}
	const cancelled = await settleCancelledPyrunCandidate(persistence, candidate, input.toolCallId, input.agentId);
	if (cancelled) return cancelled;
	if (candidate.manifest.toolCallId !== input.toolCallId) {
		throw new Error(`Pyrun tool-call artifact collision for ${input.toolCallId}`);
	}
	const expectedParams = createCanonicalPyrunEvalParams(input.params, input.ctx, input.piBridgeEnabled);
	return restorePyrunCandidate(candidate, expectedParams, input.toolCallId, input.agentId);
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
	ensurePyrunOutputFile(manifest.artifacts.outputPath);
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

function readCompletePyrunArtifactRecords(path: string): PyrunArtifactRecord[] {
	if (!existsSync(path)) return [];
	const text = readFileSync(path, "utf8");
	const lastNewline = text.lastIndexOf("\n");
	if (lastNewline === -1) return [];
	return text
		.slice(0, lastNewline)
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as PyrunArtifactRecord);
}

function formatPyrunArtifactResult(
	params: PyrunEvalParams,
	result: CanonicalPyrunEvalResult,
	records: PyrunArtifactRecord[],
): AgentToolResult<CanonicalPyrunEvalResult> {
	const reporter = createPyrunProgressReporter(undefined);
	for (const record of records) {
		if (record.kind === "progress") reporter(record.update);
	}
	const hasTruncationMarker = records.some((record) => record.kind === "truncation");
	const hasCanonicalResult = records.some((record) => record.kind === "result");
	return formatDurablePyrunEvalResult(params, result, reporter, hasTruncationMarker && hasCanonicalResult);
}

function formatDurablePyrunEvalResult(
	params: PyrunEvalParams,
	result: CanonicalPyrunEvalResult,
	reporter: PyrunProgressReporter,
	hasTruncatedProgress: boolean,
): AgentToolResult<CanonicalPyrunEvalResult> {
	if (hasTruncatedProgress) return formatCanonicalPyrunEvalResult(params, result);
	return formatStreamedPyrunEvalResult(params, result, reporter);
}

function restoreTerminalPyrunResult(records: PyrunArtifactRecord[]): CanonicalPyrunEvalResult | undefined {
	let terminalResult: CanonicalPyrunEvalResult | undefined;
	for (const record of records) {
		if (record.kind === "progress" || record.kind === "truncation") continue;
		if (terminalResult) throw new Error("Pyrun output artifact contains multiple terminal records");
		terminalResult = record.kind === "result" ? record.result : { error: record.error, type: "error" };
	}
	return terminalResult;
}

function formatLostPyrunRuntime(
	params: PyrunEvalParams,
	records: PyrunArtifactRecord[],
	outputPath: string,
): AgentToolResult<unknown> {
	const error = "Pyrun runner exited before producing a result.";
	const formatted = formatPyrunArtifactResult(
		params,
		{
			error,
			executed: params.code,
			type: "error",
		},
		records,
	);
	return {
		...formatted,
		content: formatted.content.map((item) =>
			item.type === "text" ? { ...item, text: `${item.text}\nPreserved output: ${outputPath}` } : item,
		),
		details: { ...formatted.details, outputPath, type: "lost_runtime" },
	};
}

function writeDurablePyrunScript(path: string, code: string): void {
	const temporaryPath = `${path}.tmp-${process.pid}`;
	writeFileSync(temporaryPath, code, { encoding: "utf8", mode: 0o600 });
	fsyncFile(temporaryPath);
	renameSync(temporaryPath, path);
	fsyncFile(dirname(path));
	fsyncFile(dirname(dirname(path)));
}

function fsyncFile(path: string): void {
	const descriptor = openSync(path, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function foregroundPyrunPaths(directory: string) {
	return {
		activationPath: join(directory, "activation.json"),
		bridgeRequestPath: join(directory, "foreground-bridge-requests.jsonl"),
		bridgeResponsePath: join(directory, "foreground-bridge-responses.jsonl"),
		foregroundCompletionPath: join(directory, "foreground-completed"),
		manifestPath: join(directory, "launch.json"),
		scriptPath: join(directory, "script.py"),
	};
}

function launchForegroundPyrunRunner(
	input: Parameters<typeof runDurableDetachablePyrunEvaluation>[0],
	persistence: NonNullable<ReturnType<MultiAgentStore["getPersistenceTarget"]>>,
	controller: ReturnType<typeof createDetachedJobLifecycleController>,
	startedAt: number,
	sessionSocketPath: string | undefined,
) {
	const artifacts = controller.createArtifacts(input.agentId);
	const { manifestPath, scriptPath, ...runnerPaths } = foregroundPyrunPaths(artifacts.directory);
	writeDurablePyrunScript(scriptPath, input.params.code);
	const runnerPid = launchDetachedPyrunRunner(manifestPath);
	const processIdentity = readProcessIdentity(runnerPid);
	writeDetachedPyrunLaunchManifest(manifestPath, {
		...runnerPaths,
		artifacts,
		controlDbPath: persistence.controlDbPath,
		params: createCanonicalPyrunEvalParams(input.params, input.ctx, input.piBridgeEnabled),
		runnerAddress: { agentId: input.agentId, sessionId: input.ctx.sessionManager.getSessionId() },
		runnerOptions: { ...input.runnerOptions, cwd: input.ctx.cwd },
		runnerProcessIdentity: processIdentity,
		sessionPath: persistence.sessionPath,
		sessionSocketPath,
		startedAt,
		supervisorProcessIdentity: readProcessIdentity(process.pid),
		toolCallId: input.toolCallId,
	});
	return { ...runnerPaths, artifacts, jobId: input.agentId, manifestPath, processIdentity, runnerPid, scriptPath };
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
				fileRefs: [{ label: "Pyrun script", path: input.runner.scriptPath }],
				detached: true,
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

function settleForegroundEvaluation(
	input: DetachablePyrunInput,
	artifactRead: JsonLineReadResult<PyrunArtifactRecord>,
	result: CanonicalPyrunEvalResult | undefined,
	ownership: PyrunOwnership | undefined,
	reporter: PyrunProgressReporter,
	hasTruncatedProgress: boolean,
): AgentToolResult<unknown> | undefined {
	if (ownership) return undefined;
	const foregroundError = artifactRead.values.find((record) => record.kind === "error");
	if (foregroundError) {
		writeFileSync(input.runner.foregroundCompletionPath, "failed\n", { encoding: "utf8", mode: 0o600 });
		throw new Error(foregroundError.error);
	}
	if (result) {
		writeFileSync(input.runner.foregroundCompletionPath, "completed\n", { encoding: "utf8", mode: 0o600 });
		return formatDurablePyrunEvalResult(input.params, result, reporter, hasTruncatedProgress);
	}
	if (artifactRead.hasUnreadBytes) return undefined;
	const runnerError = readForegroundPyrunRunnerError(input.runner.manifestPath, input.runner.activationPath);
	if (runnerError === undefined) return undefined;
	return failForegroundPyrunRunner(runnerError, input.runner.foregroundCompletionPath, input.runner.processIdentity);
}

function failForegroundPyrunRunner(error: string, completionPath: string, runnerIdentity: ProcessIdentity): never {
	writeFileSync(completionPath, "failed\n", { encoding: "utf8", mode: 0o600 });
	if (isProcessIdentityAlive(runnerIdentity)) terminateForegroundRunner(runnerIdentity.pid);
	throw new Error(error);
}

function readForegroundPyrunRunnerError(manifestPath: string, activationPath: string): string | undefined {
	if (existsSync(activationPath)) return undefined;
	const runnerErrorPath = `${manifestPath}.runner-error`;
	if (!existsSync(runnerErrorPath)) return undefined;
	return readFileSync(runnerErrorPath, "utf8").trim() || EMPTY_PYRUN_RUNNER_ERROR;
}

function checkForegroundRunnerLiveness(
	processIdentity: DetachablePyrunInput["runner"]["processIdentity"],
	nextCheckAt: number,
	now: number,
): number {
	if (now < nextCheckAt) return nextCheckAt;
	if (!isProcessIdentityAlive(processIdentity)) {
		throw new Error("Foreground Pyrun runner exited without producing a result");
	}
	return now + FOREGROUND_RUNNER_LIVENESS_POLL_MS;
}

function checkForegroundLiveness(
	input: DetachablePyrunInput,
	ownership: PyrunOwnership | undefined,
	hasUnreadBytes: boolean,
	nextCheckAt: number,
): number {
	if (ownership || hasUnreadBytes) return nextCheckAt;
	return checkForegroundRunnerLiveness(input.runner.processIdentity, nextCheckAt, Date.now());
}

function formatCompletedPyrunObservation(
	params: PyrunEvalParams,
	result: CanonicalPyrunEvalResult | undefined,
	terminalAgent: AgentSnapshot | undefined,
	reporter: PyrunProgressReporter,
	hasTruncatedProgress: boolean,
): AgentToolResult<unknown> {
	if (result) return formatDurablePyrunEvalResult(params, result, reporter, hasTruncatedProgress);
	if (!terminalAgent) throw new Error("Detached Pyrun job terminal state is unavailable");
	return formatTerminalAgentError(params, terminalAgent);
}

async function observeDetachablePyrunEvaluation(input: DetachablePyrunInput): Promise<AgentToolResult<unknown>> {
	const bridgeRequests: ForegroundBridgeRequests = { cursor: createJsonLineReadCursor(), failure: undefined };
	let nextLivenessCheckAt = 0;
	const outputCursor = createJsonLineReadCursor();
	let result: CanonicalPyrunEvalResult | undefined;
	let hasTruncatedProgress = false;
	let terminalAgent: AgentSnapshot | undefined;
	const reportProgress = createPyrunProgressReporter(input.onUpdate);
	const progressAccumulator = createArtifactProgressAccumulator(reportProgress, ARTIFACT_POLL_MS);
	const control = createPyrunDetachControl(input);
	const artifactWakeup = createArtifactWakeup(input.runner.artifacts.directory);
	const cancel = control.cancel;
	const unregister = input.detachRegistry.register({
		detach: () => {
			if (!control.detach()) return false;
			// A detached job outlives its tool call; aborting the call (including restart teardown) must not cancel it.
			input.signal?.removeEventListener("abort", cancel);
			return true;
		},
	});
	input.signal?.addEventListener("abort", cancel, { once: true });
	try {
		for (;;) {
			respondToPendingForegroundBridgeRequests(input, bridgeRequests, control.getOwnership() !== undefined);
			if (bridgeRequests.failure !== undefined) throw bridgeRequests.failure;
			const artifactRead = readNewArtifactRecords(input.runner.artifacts.outputPath, outputCursor);
			result = progressAccumulator.consume(artifactRead.values) ?? result;
			hasTruncatedProgress =
				hasTruncatedProgress || artifactRead.values.some((record) => record.kind === "truncation");
			const ownership = control.getOwnership();
			const foregroundResult = settleForegroundEvaluation(
				input,
				artifactRead,
				result,
				ownership,
				reportProgress,
				hasTruncatedProgress,
			);
			if (foregroundResult) return foregroundResult;
			nextLivenessCheckAt = checkForegroundLiveness(
				input,
				ownership,
				artifactRead.hasUnreadBytes,
				nextLivenessCheckAt,
			);
			if (ownership) terminalAgent = input.controller.observe(ownership.agent.id);
			if (terminalAgent && !isActiveLifecycle(terminalAgent.lifecycle)) break;
			if (ownership && control.isActivated()) {
				// The runner writes the log only when the evaluation produces output; the reported path must exist now.
				ensurePyrunOutputFile(ownership.artifacts.outputPath);
				return detachedResult(input.params, ownership.agent.id, ownership.artifacts.outputPath);
			}
			await waitForArtifactActivity(artifactWakeup, artifactRead.hasUnreadBytes);
		}
		return formatCompletedPyrunObservation(input.params, result, terminalAgent, reportProgress, hasTruncatedProgress);
	} catch (error) {
		throw withStreamedConsole(error, reportProgress);
	} finally {
		progressAccumulator.close();
		artifactWakeup.close();
		unregister();
		input.signal?.removeEventListener("abort", cancel);
	}
}

interface ForegroundBridgeRequests {
	cursor: JsonLineReadCursor;
	failure: unknown;
}

/**
 * Starts each new bridge request without awaiting it, so a request that waits on the user (a blocking
 * ask_questions) cannot keep a detached job in the foreground. The runner reads the response when it lands.
 */
function respondToPendingForegroundBridgeRequests(
	input: DetachablePyrunInput,
	requests: ForegroundBridgeRequests,
	detached: boolean,
): void {
	if (detached) return;
	for (const request of readNewJsonLines<ForegroundBridgeRequest>(input.runner.bridgeRequestPath, requests.cursor)) {
		respondToForegroundBridgeRequest(input, request).catch((error: unknown) => {
			requests.failure ??= error;
		});
	}
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
			input.toolCallId,
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

function formatTerminalAgentError(params: PyrunEvalParams, agent: AgentSnapshot): AgentToolResult<unknown> {
	const error = agent.error?.message ?? agent.result?.summary ?? `Pyrun evaluation ${agent.lifecycle}`;
	return {
		content: [{ type: "text", text: `${params.code}\n\nError: ${error}` }],
		details: { error, executed: params.code, type: "error" },
		isError: true,
	};
}

function ensurePyrunOutputFile(path: string): void {
	closeSync(openSync(path, "a", 0o600));
}

function detachedResult(params: PyrunEvalParams, jobId: string, logPath: string): AgentToolResult<unknown> {
	return {
		content: [
			{
				type: "text",
				text: `${params.code}\n\nPyrun evaluation moved to background as job ${jobId}. Output will be written to ${logPath}.`,
			},
		],
		details: { backgroundJobId: jobId, executed: params.code, type: "detached" },
	};
}
