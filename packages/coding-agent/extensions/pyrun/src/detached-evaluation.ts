import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentToolResult, ExtensionContext } from "../../../src/core/extensions/types.ts";
import { createDetachedJobLifecycleController } from "../../../src/core/detached-job-lifecycle.ts";
import { readDetachedJobTerminalEnvelope } from "../../../src/core/detached-job-runner.ts";
import { LifecycleCoordinator } from "../../../src/core/lifecycle-coordinator.ts";
import { isActiveLifecycle, type MultiAgentStore } from "../../../src/core/multi-agent-store.ts";
import { readProcessIdentity } from "../../../src/core/runtime-process.ts";
import type { ToolDetachRegistry } from "../../../src/core/tool-detach-registry.ts";
import {
	createCanonicalPyrunEvalParams,
	formatCanonicalPyrunEvalResult,
	type PyrunEvalParams,
} from "./eval-tool.ts";
import {
	launchDetachedPyrunRunner,
	writeDetachedPyrunLaunchManifest,
} from "./detached-runner.ts";
import type { CanonicalPyrunEvalResult, CanonicalPyrunProgressUpdate, PyrunRunnerOptions } from "./runner.ts";

const ARTIFACT_POLL_MS = 25;

export async function runDurableDetachablePyrunEvaluation(input: {
	ctx: ExtensionContext;
	detachRegistry: ToolDetachRegistry;
	onUpdate?: (partial: AgentToolResult<CanonicalPyrunEvalResult | CanonicalPyrunProgressUpdate>) => void;
	params: PyrunEvalParams;
	piBridgeEnabled: boolean;
	runnerOptions: PyrunRunnerOptions;
	signal?: AbortSignal;
	store: MultiAgentStore;
}): Promise<AgentToolResult<unknown>> {
	const persistence = input.store.getPersistenceTarget();
	if (!persistence) throw new Error("Detached Pyrun requires a persisted supervisor session");
	const controller = createPyrunLifecycleController(input, persistence);
	const ownership = launchOwnedPyrunRunner(input, persistence, controller);
	return observeDetachedPyrunEvaluation({ ...input, controller, ownership });
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

function launchOwnedPyrunRunner(
	input: Parameters<typeof runDurableDetachablePyrunEvaluation>[0],
	persistence: NonNullable<ReturnType<MultiAgentStore["getPersistenceTarget"]>>,
	controller: ReturnType<typeof createDetachedJobLifecycleController>,
) {
	const jobId = controller.allocateJobId();
	const artifacts = controller.createArtifacts(jobId);
	const manifestPath = join(artifacts.directory, "launch.json");
	const runnerPid = launchDetachedPyrunRunner(manifestPath);
	const ownership = controller.register({
		agentType: "pyrun",
		cwd: input.ctx.cwd,
		displayName: "Pyrun evaluation",
		jobId,
		processIdentity: readProcessIdentity(runnerPid),
		workerHandleId: String(runnerPid),
	});
	writeDetachedPyrunLaunchManifest(manifestPath, {
		artifacts,
		controlDbPath: persistence.controlDbPath,
		identity: ownership.identity,
		params: createCanonicalPyrunEvalParams(input.params, input.ctx, input.piBridgeEnabled),
		runnerAddress: { agentId: jobId, sessionId: input.ctx.sessionManager.getSessionId() },
		runnerOptions: input.runnerOptions,
		sessionPath: persistence.sessionPath,
	});
	return ownership;
}

async function observeDetachedPyrunEvaluation(input: Parameters<typeof runDurableDetachablePyrunEvaluation>[0] & {
	controller: ReturnType<typeof createDetachedJobLifecycleController>;
	ownership: ReturnType<ReturnType<typeof createDetachedJobLifecycleController>["register"]>;
}): Promise<AgentToolResult<unknown>> {
	let detached = false;
	let outputOffset = 0;
	let result: CanonicalPyrunEvalResult | undefined;
	const unregister = input.detachRegistry.register({ detach: () => (detached ? false : (detached = true)) });
	const cancel = () => input.controller.cancel(input.ownership, "Pyrun tool call aborted");
	input.signal?.addEventListener("abort", cancel, { once: true });
	try {
		for (;;) {
			const records = readNewArtifactRecords(input.ownership.artifacts.outputPath, outputOffset);
			outputOffset = records.offset;
			result = consumeArtifactRecords(records.values, input.onUpdate) ?? result;
			const agent = input.controller.observe(input.ownership.agent.id);
			if (agent && !isActiveLifecycle(agent.lifecycle)) break;
			if (detached) return detachedResult(input.params, input.ownership.agent.id, input.ownership.artifacts.outputPath);
			await new Promise((resolve) => setTimeout(resolve, ARTIFACT_POLL_MS));
		}
		if (result) return formatCanonicalPyrunEvalResult(input.params, result);
		return formatTerminalEnvelopeError(input.params, input.ownership.artifacts.terminalEnvelopePath);
	} finally {
		unregister();
		input.signal?.removeEventListener("abort", cancel);
	}
}

function consumeArtifactRecords(
	records: ReturnType<typeof readNewArtifactRecords>["values"],
	onUpdate: ((partial: AgentToolResult<CanonicalPyrunEvalResult | CanonicalPyrunProgressUpdate>) => void) | undefined,
): CanonicalPyrunEvalResult | undefined {
	let result: CanonicalPyrunEvalResult | undefined;
	for (const record of records) {
		if (record.kind === "progress") onUpdate?.({ content: [], details: record.update });
		else result = record.result;
	}
	return result;
}

function formatTerminalEnvelopeError(params: PyrunEvalParams, envelopePath: string): AgentToolResult<unknown> {
	const envelope = readDetachedJobTerminalEnvelope(envelopePath);
	const error = "error" in envelope.outcome ? envelope.outcome.error.message : envelope.outcome.kind;
	return {
		content: [{ type: "text", text: `${params.code}\n\nError: ${error}` }],
		details: { error, executed: params.code, type: "error" },
		isError: true,
	};
}

function readNewArtifactRecords(path: string, offset: number): {
	offset: number;
	values: Array<{ kind: "progress"; update: CanonicalPyrunProgressUpdate } | { kind: "result"; result: CanonicalPyrunEvalResult }>;
} {
	if (!existsSync(path)) return { offset, values: [] };
	const data = readFileSync(path);
	if (data.length <= offset) return { offset, values: [] };
	const text = data.subarray(offset).toString("utf8");
	const lines = text.split("\n").filter(Boolean);
	const values = lines.map((line) => JSON.parse(line) as ReturnType<typeof readNewArtifactRecords>["values"][number]);
	return { offset: data.length, values };
}

function detachedResult(params: PyrunEvalParams, jobId: string, logPath: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: `${params.code}\n\nPyrun evaluation moved to background as job ${jobId}. Output will be written to ${logPath}.` }],
		details: { backgroundJobId: jobId, executed: params.code, type: "completed" },
	};
}
