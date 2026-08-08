import {
	closeSync,
	existsSync,
	fsyncSync,
	fstatSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	renameSync,
	writeFileSync,
} from "node:fs";
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
const ARTIFACT_READ_BYTE_LIMIT = 1_048_576;
const DENSE_CONSOLE_RECORD_THRESHOLD = 100;
const FOREGROUND_RUNNER_LIVENESS_POLL_MS = 3_000;

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
	if (restored?.kind === "terminal") return formatCanonicalPyrunEvalResult(input.params, restored.result);
	if (restored?.kind === "lost_runtime") {
		return formatLostPyrunRuntime(input.params, restored.records, restored.outputPath);
	}
	const runner =
		restored?.kind === "resume"
			? restored.runner
			: launchForegroundPyrunRunner(input, persistence, controller, startedAt);
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
type PyrunLaunchManifest = ReturnType<typeof readDetachedPyrunLaunchManifest>;

type PyrunResumeDecision =
	| { kind: "resume"; runner: RestoredPyrunRunner }
	| { kind: "aborted"; agent: AgentSnapshot }
	| { kind: "terminal"; result: CanonicalPyrunEvalResult }
	| { kind: "lost_runtime"; outputPath: string; records: PyrunArtifactRecord[] };

interface PyrunManifestCandidate {
	directory: string;
	manifest: PyrunLaunchManifest;
	manifestPath: string;
}

function readPyrunManifestCandidate(directory: string): PyrunManifestCandidate | undefined {
	const manifestPath = join(directory, "launch.json");
	if (!existsSync(manifestPath)) return undefined;
	try {
		return { directory, manifest: readDetachedPyrunLaunchManifest(manifestPath), manifestPath };
	} catch {
		return undefined;
	}
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
	if (JSON.stringify(manifest.params) !== JSON.stringify(expectedParams)) {
		throw new Error(`Pyrun tool-call artifact collision for ${toolCallId}`);
	}
	const records = readCompletePyrunArtifactRecords(manifest.artifacts.outputPath);
	const terminalResult = restoreTerminalPyrunResult(records);
	if (terminalResult) return { kind: "terminal", result: terminalResult };
	if (!isProcessIdentityAlive(manifest.runnerProcessIdentity)) {
		return { kind: "lost_runtime", outputPath: manifest.artifacts.outputPath, records };
	}
	const scriptPath = join(directory, "script.py");
	if (!existsSync(scriptPath)) throw new Error(`Pyrun script artifact is missing: ${scriptPath}`);
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
			scriptPath,
		},
	};
}

async function restoreForegroundPyrunRunner(
	input: Parameters<typeof runDurableDetachablePyrunEvaluation>[0],
	persistence: NonNullable<ReturnType<MultiAgentStore["getPersistenceTarget"]>>,
): Promise<PyrunResumeDecision | undefined> {
	const artifactRoot = pyrunArtifactRoot(persistence.sessionPath);
	if (!existsSync(artifactRoot)) return undefined;
	const expectedParams = createCanonicalPyrunEvalParams(input.params, input.ctx, input.piBridgeEnabled);
	for (const entry of readdirSync(artifactRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const candidate = readPyrunManifestCandidate(join(artifactRoot, entry.name));
		if (!candidate) continue;
		const jobId = candidate.manifest.runnerAddress.agentId;
		if (!jobId) throw new Error(`Pyrun launch manifest has no job ID: ${candidate.manifestPath}`);
		const cancelled = await settleCancelledPyrunCandidate(persistence, candidate, input.toolCallId, jobId);
		if (cancelled) return cancelled;
		if (candidate.manifest.toolCallId !== input.toolCallId) continue;
		return restorePyrunCandidate(candidate, expectedParams, input.toolCallId, jobId);
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

function pyrunConsoleRecords(records: PyrunArtifactRecord[]): string[] {
	return records.flatMap((record) => {
		if (record.kind !== "progress" || record.update.type !== "console" || typeof record.update.text !== "string") {
			return [];
		}
		return [record.update.text];
	});
}

function restoreTerminalPyrunResult(records: PyrunArtifactRecord[]): CanonicalPyrunEvalResult | undefined {
	let terminalResult: CanonicalPyrunEvalResult | undefined;
	for (const record of records) {
		if (record.kind === "progress") continue;
		if (terminalResult) throw new Error("Pyrun output artifact contains multiple terminal records");
		terminalResult =
			record.kind === "result"
				? record.result
				: { console: pyrunConsoleRecords(records), error: record.error, type: "error" };
	}
	return terminalResult;
}

function formatLostPyrunRuntime(
	params: PyrunEvalParams,
	records: PyrunArtifactRecord[],
	outputPath: string,
): AgentToolResult<unknown> {
	const error = "Pyrun runner exited before producing a result.";
	const formatted = formatCanonicalPyrunEvalResult(params, {
		console: pyrunConsoleRecords(records),
		error,
		executed: params.code,
		type: "error",
	});
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

function launchForegroundPyrunRunner(
	input: Parameters<typeof runDurableDetachablePyrunEvaluation>[0],
	persistence: NonNullable<ReturnType<MultiAgentStore["getPersistenceTarget"]>>,
	controller: ReturnType<typeof createDetachedJobLifecycleController>,
	startedAt: number,
) {
	const { artifacts, jobId } = controller.reserveJob("pyrun");
	const activationPath = join(artifacts.directory, "activation.json");
	const bridgeRequestPath = join(artifacts.directory, "foreground-bridge-requests.jsonl");
	const bridgeResponsePath = join(artifacts.directory, "foreground-bridge-responses.jsonl");
	const foregroundCompletionPath = join(artifacts.directory, "foreground-completed");
	const manifestPath = join(artifacts.directory, "launch.json");
	const scriptPath = join(artifacts.directory, "script.py");
	writeDurablePyrunScript(scriptPath, input.params.code);
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
		scriptPath,
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
	records: PyrunArtifactRecord[],
	result: CanonicalPyrunEvalResult | undefined,
	ownership: PyrunOwnership | undefined,
): AgentToolResult<unknown> | undefined {
	if (ownership) return undefined;
	const foregroundError = records.find((record) => record.kind === "error");
	if (foregroundError) {
		writeFileSync(input.runner.foregroundCompletionPath, "failed\n", { encoding: "utf8", mode: 0o600 });
		throw new Error(foregroundError.error);
	}
	if (!result) return undefined;
	writeFileSync(input.runner.foregroundCompletionPath, "completed\n", { encoding: "utf8", mode: 0o600 });
	return formatCanonicalPyrunEvalResult(input.params, result);
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

async function observeDetachablePyrunEvaluation(input: DetachablePyrunInput): Promise<AgentToolResult<unknown>> {
	const bridgeRequestCursor = createJsonLineReadCursor();
	let nextForegroundRunnerLivenessCheckAt = 0;
	const outputCursor = createJsonLineReadCursor();
	let result: CanonicalPyrunEvalResult | undefined;
	let terminalAgent: AgentSnapshot | undefined;
	const reportProgress = createPyrunProgressReporter(input.onUpdate);
	const control = createPyrunDetachControl(input);
	const unregister = input.detachRegistry.register({ detach: control.detach });
	const cancel = control.cancel;
	input.signal?.addEventListener("abort", cancel, { once: true });
	try {
		for (;;) {
			await respondToPendingForegroundBridgeRequests(input, bridgeRequestCursor, control.getOwnership() !== undefined);
			const records = readNewArtifactRecords(input.runner.artifacts.outputPath, outputCursor);
			result = consumeArtifactRecords(records, reportProgress) ?? result;
			const ownership = control.getOwnership();
			const foregroundResult = settleForegroundEvaluation(input, records, result, ownership);
			if (foregroundResult) return foregroundResult;
			if (!ownership) {
				nextForegroundRunnerLivenessCheckAt = checkForegroundRunnerLiveness(
					input.runner.processIdentity,
					nextForegroundRunnerLivenessCheckAt,
					Date.now(),
				);
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
	cursor: JsonLineReadCursor,
	detached: boolean,
): Promise<void> {
	if (detached) return;
	const requests = readNewJsonLines<ForegroundBridgeRequest>(input.runner.bridgeRequestPath, cursor);
	for (const request of requests) await respondToForegroundBridgeRequest(input, request);
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

interface ConsoleProgressBatch {
	text: string[];
	update?: CanonicalPyrunProgressUpdate;
}

function hasDenseConsoleProgress(records: PyrunArtifactRecord[]): boolean {
	let consoleRecordCount = 0;
	for (const record of records) {
		if (record.kind !== "progress" || record.update.type !== "console") continue;
		consoleRecordCount += 1;
		if (consoleRecordCount >= DENSE_CONSOLE_RECORD_THRESHOLD) return true;
	}
	return false;
}

function consumeArtifactRecords(
	records: PyrunArtifactRecord[],
	reportProgress: (update: CanonicalPyrunProgressUpdate) => void,
): CanonicalPyrunEvalResult | undefined {
	return hasDenseConsoleProgress(records)
		? consumeDenseArtifactRecords(records, reportProgress)
		: consumeIndividualArtifactRecords(records, reportProgress);
}

function consumeIndividualArtifactRecords(
	records: PyrunArtifactRecord[],
	reportProgress: (update: CanonicalPyrunProgressUpdate) => void,
): CanonicalPyrunEvalResult | undefined {
	let result: CanonicalPyrunEvalResult | undefined;
	for (const record of records) {
		if (record.kind === "progress") reportProgress(record.update);
		else if (record.kind === "result") result = record.result;
	}
	return result;
}

function consumeDenseArtifactRecords(
	records: PyrunArtifactRecord[],
	reportProgress: (update: CanonicalPyrunProgressUpdate) => void,
): CanonicalPyrunEvalResult | undefined {
	const batch: ConsoleProgressBatch = { text: [] };
	let result: CanonicalPyrunEvalResult | undefined;
	for (const record of records) {
		if (record.kind === "progress") {
			consumeDenseProgressUpdate(record.update, batch, reportProgress);
			continue;
		}
		flushConsoleProgress(batch, reportProgress);
		if (record.kind === "result") result = record.result;
	}
	flushConsoleProgress(batch, reportProgress);
	return result;
}

function consumeDenseProgressUpdate(
	update: CanonicalPyrunProgressUpdate,
	batch: ConsoleProgressBatch,
	reportProgress: (update: CanonicalPyrunProgressUpdate) => void,
): void {
	if (update.type !== "console" || typeof update.text !== "string") {
		flushConsoleProgress(batch, reportProgress);
		reportProgress(update);
		return;
	}
	if (batch.update && batch.update.stream !== update.stream) {
		flushConsoleProgress(batch, reportProgress);
	}
	batch.update = update;
	batch.text.push(update.text);
}

function flushConsoleProgress(
	batch: ConsoleProgressBatch,
	reportProgress: (update: CanonicalPyrunProgressUpdate) => void,
): void {
	if (!batch.update) return;
	reportProgress({ ...batch.update, text: batch.text.join("") });
	batch.update = undefined;
	batch.text.length = 0;
}

function formatTerminalAgentError(params: PyrunEvalParams, agent: AgentSnapshot): AgentToolResult<unknown> {
	const error = agent.error?.message ?? agent.result?.summary ?? `Pyrun evaluation ${agent.lifecycle}`;
	return {
		content: [{ type: "text", text: `${params.code}\n\nError: ${error}` }],
		details: { error, executed: params.code, type: "error" },
		isError: true,
	};
}

interface JsonLineReadCursor {
	fragments: Buffer[];
	fragmentBytes: number;
	offset: number;
}

function createJsonLineReadCursor(): JsonLineReadCursor {
	return { fragments: [], fragmentBytes: 0, offset: 0 };
}

function readNewJsonLines<T>(path: string, cursor: JsonLineReadCursor, byteLimit?: number): T[] {
	if (!existsSync(path)) return [];
	const descriptor = openSync(path, "r");
	try {
		const size = fstatSync(descriptor).size;
		if (size <= cursor.offset) return [];
		const unreadBytes = size - cursor.offset;
		const bytesToRead = byteLimit === undefined ? unreadBytes : Math.min(unreadBytes, byteLimit);
		const data = Buffer.allocUnsafe(bytesToRead);
		const bytesRead = readSync(descriptor, data, 0, data.length, cursor.offset);
		cursor.offset += bytesRead;
		return consumeJsonLineBytes<T>(cursor, data.subarray(0, bytesRead));
	} finally {
		closeSync(descriptor);
	}
}

function consumeJsonLineBytes<T>(cursor: JsonLineReadCursor, data: Buffer): T[] {
	const values: T[] = [];
	let start = 0;
	for (;;) {
		const newline = data.indexOf(0x0a, start);
		if (newline === -1) break;
		const fragment = data.subarray(start, newline);
		const line =
			cursor.fragmentBytes === 0
				? fragment
				: Buffer.concat([...cursor.fragments, fragment], cursor.fragmentBytes + fragment.length);
		cursor.fragments = [];
		cursor.fragmentBytes = 0;
		if (line.length > 0) values.push(JSON.parse(line.toString("utf8")) as T);
		start = newline + 1;
	}
	if (start < data.length) {
		const fragment = data.subarray(start);
		cursor.fragments.push(fragment);
		cursor.fragmentBytes += fragment.length;
	}
	return values;
}

type PyrunArtifactRecord =
	| { error: string; kind: "error" }
	| { kind: "progress"; update: CanonicalPyrunProgressUpdate }
	| { kind: "result"; result: CanonicalPyrunEvalResult };

function readNewArtifactRecords(path: string, cursor: JsonLineReadCursor): PyrunArtifactRecord[] {
	return readNewJsonLines<PyrunArtifactRecord>(path, cursor, ARTIFACT_READ_BYTE_LIMIT);
}

function detachedResult(params: PyrunEvalParams, jobId: string, logPath: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: `${params.code}\n\nPyrun evaluation moved to background as job ${jobId}. Output will be written to ${logPath}.` }],
		details: { backgroundJobId: jobId, executed: params.code, type: "detached" },
	};
}
