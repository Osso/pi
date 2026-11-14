import { createDetachedJobLifecycleController } from "./detached-job-lifecycle.ts";
import type { DetachedJobLifecycleController } from "./detached-job-runner.ts";
import { LifecycleCoordinator } from "./lifecycle-coordinator.ts";
import type { AgentSnapshot, MultiAgentStore } from "./multi-agent-store.ts";
import type { ProcessIdentity } from "./runtime-process.ts";
import type { RuntimeMailboxMessage } from "./session-control-db.ts";
import type { SessionManager } from "./session-manager.ts";

export function readHeadlessToolAutoDetachAfterMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const value = env.PI_HEADLESS_TOOL_AUTO_DETACH_MS;
	if (value === undefined) return undefined;
	const milliseconds = Number(value);
	if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
		throw new Error(`PI_HEADLESS_TOOL_AUTO_DETACH_MS must be a positive integer: ${value}`);
	}
	return milliseconds;
}

/**
 * Custom session-entry type recording the terminal outcome of a detached tool
 * call (e.g. a Pyrun/Bash job that was moved to the background). The original
 * tool_result is immutable at "detached", so this entry carries the eventual
 * outcome keyed by the originating toolCallId for correlation in the transcript.
 */
export const DETACHED_TOOL_CALL_COMPLETION_CUSTOM_TYPE = "detached_tool_call_completion";

export interface DetachedToolCallCompletionEntryData {
	toolCallId: string;
	agentId: string;
	lifecycle: "completed" | "failed" | "aborted";
	summary?: string;
	error?: string;
}

/**
 * Builds the transcript entry data for a detached tool call's terminal outcome,
 * or undefined when the agent is not a terminal detached tool-call job (no
 * originating toolCallId on its active worker or terminal result, or still active).
 */
export function buildDetachedToolCallCompletionEntry(
	agent: AgentSnapshot | undefined,
): DetachedToolCallCompletionEntryData | undefined {
	const toolCallId = agent?.worker?.toolCallId ?? agent?.result?.toolCallId;
	if (!agent || !toolCallId) return undefined;
	if (agent.lifecycle !== "completed" && agent.lifecycle !== "failed" && agent.lifecycle !== "aborted") {
		return undefined;
	}
	return {
		agentId: agent.id,
		lifecycle: agent.lifecycle,
		toolCallId,
		...(agent.result?.summary === undefined ? {} : { summary: agent.result.summary }),
		...(agent.error?.message === undefined ? {} : { error: agent.error.message }),
	};
}

export function createAgentSessionDetachedJobLifecycleController(input: {
	store: MultiAgentStore | undefined;
	controlDbPath: string | undefined;
	processIdentity: ProcessIdentity;
	artifactRoot: string;
	ownerAgentId: string | undefined;
	ownerSessionId: string;
}): DetachedJobLifecycleController | undefined {
	const store = input.store;
	const persistence = store?.getPersistenceTarget();
	const controlDbPath = input.controlDbPath;
	if (!store || !persistence || !controlDbPath) return undefined;
	const coordinator = new LifecycleCoordinator({
		controlDbPath,
		createAgentId: () => store.allocateAgentIdForLifecycleCoordinator(),
		now: () => new Date().toISOString(),
		processIdentity: input.processIdentity,
		sessionPath: persistence.sessionPath,
	});
	return createDetachedJobLifecycleController({
		artifactRoot: input.artifactRoot,
		controlDbPath,
		coordinator,
		ownerAgentId: input.ownerAgentId,
		ownerSessionId: input.ownerSessionId,
		sessionPath: persistence.sessionPath,
		store,
	});
}

export function recordDetachedToolCallCompletion(input: {
	message: RuntimeMailboxMessage;
	store: MultiAgentStore | undefined;
	sessionManager: SessionManager;
}): void {
	const senderId = input.message.sender.agentId;
	if (!input.store || !senderId) return;
	const data = buildDetachedToolCallCompletionEntry(input.store.getAgent(senderId));
	if (!data) return;
	const alreadyRecorded = input.sessionManager.getEntries().some((entry) => {
		if (entry.type !== "custom" || entry.customType !== DETACHED_TOOL_CALL_COMPLETION_CUSTOM_TYPE) return false;
		const existing = entry.data;
		return (
			typeof existing === "object" &&
			existing !== null &&
			"agentId" in existing &&
			existing.agentId === data.agentId &&
			"toolCallId" in existing &&
			existing.toolCallId === data.toolCallId
		);
	});
	if (!alreadyRecorded) {
		input.sessionManager.appendCustomEntry(DETACHED_TOOL_CALL_COMPLETION_CUSTOM_TYPE, data);
	}
}
