import { basename, extname, join } from "node:path";
import { launchDetachedBashRunner, writeDetachedBashLaunchManifest } from "./detached-bash-runner.ts";
import {
	createDetachedJobArtifacts,
	type DetachedJobLifecycleController,
	type DetachedJobOwnership,
	type RegisterDetachedJobInput,
	reserveDetachedJobArtifacts,
} from "./detached-job-runner.ts";
import type { LifecycleCoordinator } from "./lifecycle-coordinator.ts";
import { isActiveLifecycle, type MultiAgentStore } from "./multi-agent-store.ts";
import { isProcessIdentityAlive, readProcessIdentity } from "./runtime-process.ts";
import { readMultiAgentAgent, readMultiAgentRuntimeOwnership } from "./session-control-db.ts";

export interface DetachedJobLifecycleControllerOptions {
	artifactRoot: string;
	writeBashLaunchManifest?: typeof writeDetachedBashLaunchManifest;
	controlDbPath: string;
	coordinator: LifecycleCoordinator;
	ownerAgentId?: string;
	ownerSessionId: string;
	sessionPath: string;
	store: MultiAgentStore;
}

export function createDetachedJobLifecycleController(
	options: DetachedJobLifecycleControllerOptions,
): DetachedJobLifecycleController {
	const artifactRoot = detachedJobArtifactRoot(options);
	return {
		allocateJobId: (agentType) => options.store.allocateAgentIdForLifecycleCoordinator(agentType),
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
		createArtifacts: (jobId) => reserveDetachedJobArtifacts(artifactRoot, jobId),
		launchBash: (input) => launchDetachedBashJob(options, input),
		observe: (jobId) => {
			let agent = readMultiAgentAgent(options.controlDbPath, options.sessionPath, jobId);
			if (!agent) return undefined;
			const ownership = readMultiAgentRuntimeOwnership(options.controlDbPath, options.sessionPath, jobId);
			if (
				isActiveLifecycle(agent.lifecycle) &&
				ownership?.processIdentity &&
				ownership.sessionPath === options.sessionPath &&
				ownership.agentId === jobId &&
				ownership.owner.agentId === (options.ownerAgentId ?? null) &&
				ownership.owner.sessionId === options.ownerSessionId &&
				!isProcessIdentityAlive(ownership.processIdentity)
			) {
				const recovered = options.coordinator.recoverDeadChild({
					agent,
					ownerSessionId: options.ownerSessionId,
					ownership,
					supervisorAgentId: options.ownerAgentId,
				});
				if (recovered.ok) agent = recovered.agent;
			}
			options.store.publishLifecycleCoordinatorSnapshot(agent);
			return agent;
		},
		register: (input) => registerDetachedJob(options, input),
	};
}

function launchDetachedBashJob(
	options: DetachedJobLifecycleControllerOptions,
	input: Parameters<DetachedJobLifecycleController["launchBash"]>[0],
): ReturnType<DetachedJobLifecycleController["launchBash"]> {
	const jobId = options.store.allocateAgentIdForLifecycleCoordinator("bash");
	const artifacts = reserveDetachedJobArtifacts(detachedJobArtifactRoot(options), jobId);
	const manifestPath = join(artifacts.directory, "launch.json");
	const runnerPid = launchDetachedBashRunner(manifestPath);
	const ownership = registerDetachedJob(options, {
		agentType: "bash",
		cwd: input.cwd,
		displayName: "Bash command",
		jobId,
		processIdentity: readProcessIdentity(runnerPid),
		workerHandleId: String(runnerPid),
		toolCallId: input.toolCallId,
	});
	try {
		(options.writeBashLaunchManifest ?? writeDetachedBashLaunchManifest)(manifestPath, {
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
			toolCallId: input.toolCallId,
		});
	} catch (error) {
		terminateDetachedRunner(runnerPid);
		const failed = options.coordinator.failDetachedLaunch({
			agent: ownership.agent,
			error: { code: "runtime_spawn_failed", message: error instanceof Error ? error.message : String(error) },
			ownership: ownership.controlOwnership,
			terminalLifecycle: "failed",
		});
		if (failed.ok) options.store.publishLifecycleCoordinatorSnapshot(failed.agent);
		throw error;
	}
	return { manifestPath, ownership, runnerPid };
}

function detachedJobArtifactRoot(options: DetachedJobLifecycleControllerOptions): string {
	const sessionFileName = basename(options.sessionPath);
	const sessionName = sessionFileName.slice(0, sessionFileName.length - extname(sessionFileName).length);
	if (!sessionName) throw new Error("Detached job session path must have a file name");
	return join(options.artifactRoot, "detached-jobs", sessionName);
}

function terminateDetachedRunner(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

function registerDetachedJob(
	options: DetachedJobLifecycleControllerOptions,
	input: RegisterDetachedJobInput,
): DetachedJobOwnership {
	const artifacts = createDetachedJobArtifacts(detachedJobArtifactRoot(options), input.jobId);
	const outputLabel = input.agentType === "bash" ? "Bash output" : "Pyrun output";
	const prepared = options.coordinator.prepareChild({
		agentId: input.jobId,
		agentType: "background",
		cwd: input.cwd,
		displayName: input.displayName,
		parentId: options.ownerAgentId,
		permission: { narrowed: true, policy: "on-request" },
		result: { fileRefs: [{ label: outputLabel, path: artifacts.outputPath }] },
		worker: { adapter: "runtime", cwd: input.cwd, handleId: input.workerHandleId, toolCallId: input.toolCallId },
	});
	const created = options.coordinator.commitRunningChild(
		prepared,
		options.ownerSessionId,
		input.processIdentity,
		options.ownerAgentId ?? null,
	);
	if (!created.ok) throw new Error(`Could not own detached ${input.agentType} job: ${created.error}`);
	options.store.publishLifecycleCoordinatorSnapshot(created.agent);
	const processIdentity = created.ownership.processIdentity;
	if (!processIdentity) throw new Error("Detached job ownership identity is incomplete");
	return {
		agent: created.agent,
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
