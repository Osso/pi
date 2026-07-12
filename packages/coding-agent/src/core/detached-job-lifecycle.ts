import { join } from "node:path";
import { launchDetachedBashRunner, writeDetachedBashLaunchManifest } from "./detached-bash-runner.ts";
import {
	createDetachedJobArtifacts,
	type DetachedJobLifecycleController,
	type DetachedJobOwnership,
	type RegisterDetachedJobInput,
} from "./detached-job-runner.ts";
import type { LifecycleCoordinator } from "./lifecycle-coordinator.ts";
import type { MultiAgentStore } from "./multi-agent-store.ts";
import { readProcessIdentity } from "./runtime-process.ts";
import { finalizeDetachedJob, readMultiAgentAgent } from "./session-control-db.ts";

export interface DetachedJobLifecycleControllerOptions {
	artifactRoot: string;
	controlDbPath: string;
	coordinator: LifecycleCoordinator;
	ownerSessionId: string;
	sessionPath: string;
	store: MultiAgentStore;
}

export function createDetachedJobLifecycleController(
	options: DetachedJobLifecycleControllerOptions,
): DetachedJobLifecycleController {
	return {
		allocateJobId: () => options.store.allocateAgentIdForLifecycleCoordinator(),
		cancel: (ownership, reason) => {
			const cancelled = options.coordinator.requestDetachedCancellation({
				agent: ownership.agent,
				outputLabel: ownership.identity.outputLabel,
				ownership: ownership.controlOwnership,
				reason,
			});
			if (cancelled.ok) options.store.publishLifecycleCoordinatorSnapshot(cancelled.agent);
			return cancelled;
		},
		createArtifacts: (jobId) => createDetachedJobArtifacts(join(options.artifactRoot, "detached-jobs"), jobId),
		finalize: (envelopePath) => {
			const finalized = finalizeDetachedJob(options.controlDbPath, {
				envelopePath,
				sessionPath: options.sessionPath,
			});
			if (finalized.ok) options.store.publishLifecycleCoordinatorSnapshot(finalized.terminalAgent);
			return finalized;
		},
		launchBash: (input) => launchDetachedBashJob(options, input),
		observe: (jobId) => {
			const agent = readMultiAgentAgent(options.controlDbPath, options.sessionPath, jobId);
			if (agent) options.store.publishLifecycleCoordinatorSnapshot(agent);
			return agent;
		},
		register: (input) => registerDetachedJob(options, input),
	};
}

function launchDetachedBashJob(
	options: DetachedJobLifecycleControllerOptions,
	input: Parameters<DetachedJobLifecycleController["launchBash"]>[0],
): ReturnType<DetachedJobLifecycleController["launchBash"]> {
	const jobId = options.store.allocateAgentIdForLifecycleCoordinator();
	const artifacts = createDetachedJobArtifacts(join(options.artifactRoot, "detached-jobs"), jobId);
	const manifestPath = join(artifacts.directory, "launch.json");
	const runnerPid = launchDetachedBashRunner(manifestPath);
	const ownership = registerDetachedJob(options, {
		agentType: "bash",
		cwd: input.cwd,
		displayName: "Bash command",
		jobId,
		processIdentity: readProcessIdentity(runnerPid),
		workerHandleId: String(runnerPid),
	});
	writeDetachedBashLaunchManifest(manifestPath, {
		args: input.args,
		artifacts,
		command: input.command,
		controlDbPath: options.controlDbPath,
		cwd: input.cwd,
		env: input.env,
		identity: ownership.identity,
		runnerAddress: { agentId: jobId, sessionId: options.ownerSessionId },
		sessionPath: options.sessionPath,
		timeoutMs: input.timeoutMs,
	});
	return { manifestPath, ownership, runnerPid };
}

function registerDetachedJob(
	options: DetachedJobLifecycleControllerOptions,
	input: RegisterDetachedJobInput,
): DetachedJobOwnership {
	const artifacts = createDetachedJobArtifacts(join(options.artifactRoot, "detached-jobs"), input.jobId);
	const outputLabel = input.agentType === "bash" ? "Bash output" : "Pyrun output";
	const created = options.coordinator.createChild({
		agentId: input.jobId,
		agentType: "background",
		cwd: input.cwd,
		displayName: input.displayName,
		ownerSessionId: options.ownerSessionId,
		permission: { narrowed: true, policy: "on-request" },
		processIdentity: input.processIdentity,
		result: { fileRefs: [{ label: outputLabel, path: artifacts.outputPath }] },
		worker: { adapter: "runtime", cwd: input.cwd, handleId: input.workerHandleId },
	});
	if (!created.ok) throw new Error(`Could not own detached ${input.agentType} job: ${created.error}`);
	const starting = options.coordinator.beginChildRuntime({ agent: created.agent, ownership: created.ownership });
	if (!starting.ok) throw new Error(`Could not start detached ${input.agentType} job: ${starting.error}`);
	const running = options.coordinator.confirmChildRuntime({ agent: starting.agent, ownership: created.ownership });
	if (!running.ok) throw new Error(`Could not confirm detached ${input.agentType} job: ${running.error}`);
	options.store.publishLifecycleCoordinatorSnapshot(running.agent);
	const processIdentity = created.ownership.processIdentity;
	if (!processIdentity) throw new Error("Detached job ownership identity is incomplete");
	return {
		agent: running.agent,
		artifacts,
		controlOwnership: created.ownership,
		identity: {
			jobId: input.jobId,
			owner: {
				agentId: created.ownership.owner.agentId,
				sessionId: created.ownership.owner.sessionId ?? options.ownerSessionId,
			},
			outputLabel,
			processIdentity,
		},
	};
}
