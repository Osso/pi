import { randomUUID } from "node:crypto";
import type { DetachedJobLeaseIdentity } from "../../../src/core/detached-job-runner.ts";
import {
	enqueueStoredRuntimeMailboxMessage,
	readMultiAgentAgent,
	readMultiAgentDispatchLease,
	type RuntimeMailboxAddress,
	type RuntimeMailboxMessage,
} from "../../../src/core/session-control-db.ts";

const DETACHED_PYRUN_BRIDGE_PROTOCOL = "pyrun-bridge-v1";

export interface DetachedPyrunBridgeRequest {
	command: "request";
	identity: DetachedJobLeaseIdentity;
	method: string;
	params: unknown;
	protocol: typeof DETACHED_PYRUN_BRIDGE_PROTOCOL;
	replyTo: RuntimeMailboxAddress;
	requestId: string;
}

export function enqueueDetachedPyrunBridgeRequest(input: {
	controlDbPath: string;
	identity: DetachedJobLeaseIdentity;
	method: string;
	params: unknown;
	runnerAddress: RuntimeMailboxAddress;
	sessionPath: string;
	supervisorAddress: RuntimeMailboxAddress;
}): string {
	const requestId = randomUUID();
	const body: DetachedPyrunBridgeRequest = {
		command: "request",
		identity: input.identity,
		method: input.method,
		params: input.params,
		protocol: DETACHED_PYRUN_BRIDGE_PROTOCOL,
		replyTo: input.runnerAddress,
		requestId,
	};
	persistBridgeMessage({
		body,
		controlDbPath: input.controlDbPath,
		fromAgentId: input.identity.jobId,
		messageId: `pyrun-request:${input.identity.jobId}:${requestId}`,
		recipient: input.supervisorAddress,
		sender: input.runnerAddress,
		sessionPath: input.sessionPath,
		toAgentId: "main",
	});
	return requestId;
}

export function parseDetachedPyrunBridgeRequest(message: RuntimeMailboxMessage): DetachedPyrunBridgeRequest | undefined {
	try {
		const parsed = JSON.parse(message.body) as DetachedPyrunBridgeRequest;
		if (
			parsed.protocol !== DETACHED_PYRUN_BRIDGE_PROTOCOL ||
			parsed.command !== "request" ||
			typeof parsed.requestId !== "string" ||
			typeof parsed.method !== "string" ||
			!parsed.identity ||
			!parsed.replyTo
		) {
			return undefined;
		}
		return parsed;
	} catch {
		return undefined;
	}
}

export function validateDetachedPyrunBridgeRequest(input: {
	controlDbPath: string;
	message: RuntimeMailboxMessage;
	nowIso: string;
	request: DetachedPyrunBridgeRequest;
	sessionPath: string;
	supervisorSessionId: string;
}): boolean {
	const { identity } = input.request;
	if (input.message.sender.agentId !== identity.jobId) return false;
	const agent = readMultiAgentAgent(input.controlDbPath, input.sessionPath, identity.jobId);
	const lease = readMultiAgentDispatchLease(input.controlDbPath, input.sessionPath, identity.jobId);
	return (
		agent?.lifecycle === "running" &&
		identity.owner.sessionId === input.supervisorSessionId &&
		lease?.owner.sessionId === identity.owner.sessionId &&
		lease.owner.agentId === identity.owner.agentId &&
		lease.processIdentity?.pid === identity.processIdentity.pid &&
		lease.processIdentity.startTimeTicks === identity.processIdentity.startTimeTicks
	);
}

export function enqueueDetachedPyrunBridgeResponse(input: {
	controlDbPath: string;
	error?: string;
	request: DetachedPyrunBridgeRequest;
	result?: unknown;
	sessionPath: string;
	supervisorAddress: RuntimeMailboxAddress;
}): void {
	const messageId = `pyrun-response:${input.request.identity.jobId}:${input.request.requestId}`;
	const body = {
		command: "respond",
		error: input.error,
		identity: input.request.identity,
		requestId: input.request.requestId,
		result: input.result,
	};
	persistBridgeMessage({
		body,
		controlDbPath: input.controlDbPath,
		fromAgentId: "main",
		messageId,
		recipient: input.request.replyTo,
		sender: input.supervisorAddress,
		sessionPath: input.sessionPath,
		toAgentId: input.request.identity.jobId,
	});
}

function persistBridgeMessage(input: {
	body: unknown;
	controlDbPath: string;
	fromAgentId: string;
	messageId: string;
	recipient: RuntimeMailboxAddress;
	sender: RuntimeMailboxAddress;
	sessionPath: string;
	toAgentId: string;
}): void {
	enqueueStoredRuntimeMailboxMessage(input.controlDbPath, {
		kind: "system",
		message: {
			body: JSON.stringify(input.body),
			fromAgentId: input.fromAgentId,
			id: input.messageId,
			kind: "system",
			status: "pending",
			toAgentId: input.toAgentId,
		},
		recipient: input.recipient,
		sender: input.sender,
		storeRef: { messageId: input.messageId, sessionPath: input.sessionPath },
	});
}
