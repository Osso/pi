import type { DetachedJobLeaseIdentity } from "./detached-job-runner.ts";
import {
	claimRuntimeMailboxMessages,
	deliverRuntimeMailboxMessage,
	enqueueStoredRuntimeMailboxMessage,
	failRuntimeMailboxMessage,
	type RuntimeMailboxAddress,
} from "./session-control-db.ts";

export interface DetachedJobCancelCommand {
	command: "cancel";
	identity: DetachedJobLeaseIdentity;
	reason?: string;
	transportId: number;
}

export interface DetachedJobStatusCommand {
	command: "status";
	identity: DetachedJobLeaseIdentity;
	replyTo: RuntimeMailboxAddress;
	requestId: string;
	transportId: number;
}

export interface DetachedJobResponseCommand {
	command: "respond";
	error?: string;
	identity: DetachedJobLeaseIdentity;
	requestId: string;
	result?: unknown;
	transportId: number;
}

export type DetachedJobRuntimeCommand =
	| DetachedJobCancelCommand
	| DetachedJobStatusCommand
	| DetachedJobResponseCommand;

type StoredDetachedJobRuntimeCommand =
	| Omit<DetachedJobCancelCommand, "transportId">
	| Omit<DetachedJobStatusCommand, "transportId">
	| Omit<DetachedJobResponseCommand, "transportId">;

export function claimDetachedJobRuntimeCommands(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
	identity: DetachedJobLeaseIdentity,
): DetachedJobRuntimeCommand[] {
	const commands: DetachedJobRuntimeCommand[] = [];
	for (const message of claimRuntimeMailboxMessages(controlDbPath, recipient)) {
		const command = parseRuntimeCommand(message.body);
		if (!command || !commandIdentityMatches(command, identity)) {
			failRuntimeMailboxMessage(controlDbPath, message.id, "Detached job control identity mismatch");
			continue;
		}
		if (!deliverRuntimeMailboxMessage(controlDbPath, message.id)) {
			failRuntimeMailboxMessage(controlDbPath, message.id, "Detached job control delivery failed");
			continue;
		}
		commands.push({ ...command, transportId: message.id });
	}
	return commands;
}

export function enqueueDetachedJobStatusRequest(input: {
	controlDbPath: string;
	identity: DetachedJobLeaseIdentity;
	requesterAddress: RuntimeMailboxAddress;
	requestId: string;
	runnerAddress: RuntimeMailboxAddress;
	sessionPath: string;
}): number {
	const messageId = `detached-status-request:${input.identity.jobId}:${input.requestId}`;
	return enqueueStoredRuntimeMailboxMessage(input.controlDbPath, {
		kind: "system",
		message: {
			body: JSON.stringify({
				command: "status",
				identity: input.identity,
				replyTo: input.requesterAddress,
				requestId: input.requestId,
			}),
			fromAgentId: input.requesterAddress.agentId ?? "main",
			id: messageId,
			kind: "system",
			status: "pending",
			toAgentId: input.identity.jobId,
		},
		recipient: input.runnerAddress,
		sender: input.requesterAddress,
		storeRef: { messageId, sessionPath: input.sessionPath },
	});
}

export function enqueueDetachedJobStatusResponse(input: {
	controlDbPath: string;
	identity: DetachedJobLeaseIdentity;
	replyTo: RuntimeMailboxAddress;
	requestId: string;
	runnerAddress: RuntimeMailboxAddress;
	sessionPath: string;
	status: Record<string, unknown>;
}): number {
	const messageId = `detached-status:${input.identity.jobId}:${input.requestId}`;
	return enqueueStoredRuntimeMailboxMessage(input.controlDbPath, {
		kind: "system",
		message: {
			body: JSON.stringify({
				command: "respond",
				identity: input.identity,
				requestId: input.requestId,
				result: input.status,
			}),
			fromAgentId: input.identity.jobId,
			id: messageId,
			kind: "system",
			status: "pending",
			toAgentId: input.replyTo.agentId ?? "main",
		},
		recipient: input.replyTo,
		sender: input.runnerAddress,
		storeRef: { messageId, sessionPath: input.sessionPath },
	});
}

export function claimDetachedJobControlCommands(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
	identity: DetachedJobLeaseIdentity,
): DetachedJobCancelCommand[] {
	return claimDetachedJobRuntimeCommands(controlDbPath, recipient, identity).filter(
		(command): command is DetachedJobCancelCommand => command.command === "cancel",
	);
}

function parseRuntimeCommand(body: string): StoredDetachedJobRuntimeCommand | undefined {
	try {
		const parsed = JSON.parse(body) as unknown;
		if (!isRecord(parsed) || !isDetachedJobIdentity(parsed.identity)) return undefined;
		if (parsed.command === "cancel") {
			return {
				command: "cancel",
				identity: parsed.identity,
				reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
			};
		}
		if (
			parsed.command === "status" &&
			typeof parsed.requestId === "string" &&
			isRuntimeMailboxAddress(parsed.replyTo)
		) {
			return {
				command: "status",
				identity: parsed.identity,
				replyTo: parsed.replyTo,
				requestId: parsed.requestId,
			};
		}
		if (parsed.command === "respond" && typeof parsed.requestId === "string") {
			return {
				command: "respond",
				error: typeof parsed.error === "string" ? parsed.error : undefined,
				identity: parsed.identity,
				requestId: parsed.requestId,
				result: parsed.result,
			};
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function isRuntimeMailboxAddress(value: unknown): value is RuntimeMailboxAddress {
	if (!isRecord(value)) return false;
	return (
		typeof value.sessionId === "string" &&
		(value.agentId === null || value.agentId === undefined || typeof value.agentId === "string")
	);
}

function isDetachedJobIdentity(value: unknown): value is DetachedJobLeaseIdentity {
	if (!isRecord(value)) return false;
	return (
		typeof value.jobId === "string" &&
		typeof value.expectedRevision === "number" &&
		typeof value.leaseId === "string" &&
		typeof value.runtimeIncarnation === "string" &&
		typeof value.fencingEpoch === "number" &&
		typeof value.outputLabel === "string"
	);
}

function commandIdentityMatches(command: StoredDetachedJobRuntimeCommand, current: DetachedJobLeaseIdentity): boolean {
	const expectedRevision = command.command === "cancel" ? current.expectedRevision + 1 : current.expectedRevision;
	return sameLeaseIdentity(command.identity, current, expectedRevision);
}

function sameLeaseIdentity(
	candidate: DetachedJobLeaseIdentity,
	current: DetachedJobLeaseIdentity,
	expectedRevision: number,
): boolean {
	return (
		candidate.jobId === current.jobId &&
		candidate.expectedRevision === expectedRevision &&
		candidate.leaseId === current.leaseId &&
		candidate.runtimeIncarnation === current.runtimeIncarnation &&
		candidate.fencingEpoch === current.fencingEpoch &&
		candidate.outputLabel === current.outputLabel
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
