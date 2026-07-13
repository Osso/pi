import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentToolResult, ExtensionContext } from "../../../src/core/extensions/types.ts";
import { createDetachedJobLifecycleController } from "../../../src/core/detached-job-lifecycle.ts";
import { LifecycleCoordinator } from "../../../src/core/lifecycle-coordinator.ts";
import { isActiveLifecycle, type AgentSnapshot, type MultiAgentStore } from "../../../src/core/multi-agent-store.ts";
import { isProcessIdentityAlive, readProcessIdentity } from "../../../src/core/runtime-process.ts";
import type { ToolDetachRegistry } from "../../../src/core/tool-detach-registry.ts";
import {
	createCanonicalPyrunEvalParams,
	formatCanonicalPyrunEvalResult,
	type PyrunEvalParams,
	type PyrunPiRequestDispatcher,
} from "./eval-tool.ts";
import {
	launchDetachedPyrunRunner,
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
	runnerOptions: PyrunRunnerOptions;
	signal?: AbortSignal;
	store: MultiAgentStore;
	writeActivation?: typeof writeDetachedPyrunActivation;
}): Promise<AgentToolResult<unknown>> {
	const persistence = input.store.getPersistenceTarget();
	if (!persistence) throw new Error("Detached Pyrun requires a persisted supervisor session");
	const controller = createPyrunLifecycleController(input, persistence);
	const runner = launchForegroundPyrunRunner(input, persistence, controller);
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
		ownerSessionId: input.ctx.sessionManager.getSessionId(),
		sessionPath: persistence.sessionPath,
		store: input.store,
	});
}

function launchForegroundPyrunRunner(
	input: Parameters<typeof runDurableDetachablePyrunEvaluation>[0],
	persistence: NonNullable<ReturnType<MultiAgentStore["getPersistenceTarget"]>>,
	controller: ReturnType<typeof createDetachedJobLifecycleController>,
) {
	const jobId = controller.allocateJobId();
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
		sessionPath: persistence.sessionPath,
		supervisorProcessIdentity: readProcessIdentity(process.pid),
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
			result = consumeArtifactRecords(records.values, input.onUpdate) ?? result;
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
	onUpdate: ((partial: AgentToolResult<CanonicalPyrunEvalResult | CanonicalPyrunProgressUpdate>) => void) | undefined,
): CanonicalPyrunEvalResult | undefined {
	let result: CanonicalPyrunEvalResult | undefined;
	for (const record of records) {
		if (record.kind === "progress") onUpdate?.({ content: [], details: record.update });
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
		details: { backgroundJobId: jobId, executed: params.code, type: "completed" },
	};
}
