import { isAbsolute } from "node:path";
import type {
	AgentEventStreamMetadata,
	AgentFileReference,
	AgentMailboxMessage,
	AgentNode,
	AgentResult,
	AgentSnapshot,
	AgentTranscriptMetadata,
	AgentWorkerAdapter,
} from "./multi-agent-types.ts";

export function copyAgent(agent: AgentNode): AgentSnapshot {
	return {
		...agent,
		account: copyAccount(agent.account),
		error: copyOptional(agent.error),
		currentActivity: copyOptional(agent.currentActivity),
		lastActivity: copyOptional(agent.lastActivity),
		model: copyOptional(agent.model),
		permission: { ...agent.permission },
		result: copyResult(agent.result),
		slot: copyOptional(agent.slot),
		eventStream: copyEventStream(agent.eventStream),
		transcript: copyTranscript(agent.transcript),
		worker: copyWorker(agent.worker),
		worktree: copyWorktree(agent.worktree),
	};
}

export function copyMessage(message: AgentMailboxMessage): AgentMailboxMessage {
	return {
		body: message.body,
		createdAt: message.createdAt,
		error: message.error,
		fileRefs: copyFileRefs(message.fileRefs),
		fromAgentId: message.fromAgentId,
		id: message.id,
		kind: message.kind,
		status: message.status,
		targetCheckpoint: message.targetCheckpoint,
		threadId: message.threadId,
		toAgentId: message.toAgentId,
		updatedAt: message.updatedAt,
	};
}

function copyAccount(account: AgentNode["account"] | undefined): AgentNode["account"] | undefined {
	if (!account) {
		return undefined;
	}
	return {
		budgetId: account.budgetId,
		concurrencyCap: account.concurrencyCap,
		id: account.id,
		providerFallback: account.providerFallback ? [...account.providerFallback] : undefined,
		rateLimit: account.rateLimit ? { ...account.rateLimit } : undefined,
		tokenBudget: account.tokenBudget ? { ...account.tokenBudget } : undefined,
	};
}

function copyWorker(worker: AgentWorkerAdapter | undefined): AgentWorkerAdapter | undefined {
	if (!worker) {
		return undefined;
	}
	validateOptionalPath(worker.cwd, "agent_worker.cwd");
	return {
		adapter: worker.adapter,
		cwd: worker.cwd,
		handleId: worker.handleId,
		toolCallId: worker.toolCallId,
	};
}

export function copyTranscript(transcript: AgentTranscriptMetadata | undefined): AgentTranscriptMetadata | undefined {
	if (!transcript) {
		return undefined;
	}
	validateOptionalPath(transcript.path, "agent_transcript.path");
	return {
		path: transcript.path,
		sessionId: transcript.sessionId,
	};
}

function copyEventStream(eventStream: AgentEventStreamMetadata | undefined): AgentEventStreamMetadata | undefined {
	if (!eventStream) {
		return undefined;
	}
	validateAbsolutePath(eventStream.path, "agent_event_stream.path");
	return {
		byteLimit: eventStream.byteLimit,
		eventCount: eventStream.eventCount,
		path: eventStream.path,
		truncated: eventStream.truncated,
	};
}

function copyOptional<T extends object>(value: T | undefined): T | undefined {
	return value ? { ...value } : undefined;
}

function copyWorktree(worktree: AgentNode["worktree"]): AgentNode["worktree"] {
	if (!worktree) {
		return undefined;
	}
	validateAbsolutePath(worktree.path, "agent_worktree.path");
	return { ...worktree };
}

function validateAbsolutePath(path: string, context: string): void {
	if (!isAbsolute(path)) {
		throw new Error(`Invalid path at ${context}: expected an absolute path, received ${path}`);
	}
}

export function validateOptionalPath(path: string | undefined, context: string): void {
	if (path !== undefined) {
		validateAbsolutePath(path, context);
	}
}

export function copyFileRefs(refs: AgentFileReference[] | undefined): AgentFileReference[] | undefined {
	return validateFileRefs(refs, "file_reference_copy");
}

export function validateFileRefs(
	refs: AgentFileReference[] | undefined,
	context: string,
): AgentFileReference[] | undefined {
	if (!refs) {
		return undefined;
	}
	return refs.map((ref, index) => {
		if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
			throw new Error(`Invalid file reference at ${context}[${index}]`);
		}
		if (typeof ref.path !== "string" || !isAbsolute(ref.path)) {
			const path = typeof ref.path === "string" ? ref.path : String(ref.path);
			throw new Error(`Invalid file reference at ${context}[${index}]: path must be absolute, received ${path}`);
		}
		if (ref.label !== undefined && typeof ref.label !== "string") {
			throw new Error(`Invalid file reference at ${context}[${index}]: label must be a string`);
		}
		return { path: ref.path, label: ref.label };
	});
}

function copyResult(result: AgentResult | undefined): AgentResult | undefined {
	if (!result) {
		return undefined;
	}
	return {
		durationMs: result.durationMs,
		fileRefs: validateFileRefs(result.fileRefs, "agent_result"),
		summary: result.summary,
		toolCallId: result.toolCallId,
	};
}
