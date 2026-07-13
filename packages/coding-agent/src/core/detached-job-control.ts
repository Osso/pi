import type { DetachedJobOwnershipIdentity } from "./detached-job-runner.ts";
import {
	claimRuntimeMailboxMessages,
	deliverRuntimeMailboxMessage,
	enqueueStoredRuntimeMailboxMessage,
	failRuntimeMailboxMessage,
	type RuntimeMailboxAddress,
} from "./session-control-db.ts";

export interface DetachedJobCancelCommand {
	command: "cancel";
	identity: DetachedJobOwnershipIdentity;
	reason?: string;
	mailboxRowId: number;
}

export interface DetachedJobStatusCommand {
	command: "status";
	identity: DetachedJobOwnershipIdentity;
	replyTo: RuntimeMailboxAddress;
	requestId: string;
	mailboxRowId: number;
}

export interface DetachedJobResponseCommand {
	command: "respond";
	error?: string;
	identity: DetachedJobOwnershipIdentity;
	requestId: string;
	result?: unknown;
	mailboxRowId: number;
}

export type DetachedJobRuntimeCommand =
	| DetachedJobCancelCommand
	| DetachedJobStatusCommand
	| DetachedJobResponseCommand;

type StoredDetachedJobRuntimeCommand =
	| Omit<DetachedJobCancelCommand, "mailboxRowId">
	| Omit<DetachedJobStatusCommand, "mailboxRowId">
	| Omit<DetachedJobResponseCommand, "mailboxRowId">;

export function claimDetachedJobRuntimeCommands(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
	identity: DetachedJobOwnershipIdentity,
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
		commands.push({ ...command, mailboxRowId: message.id });
	}
	return commands;
}

export function enqueueDetachedJobStatusRequest(input: {
	controlDbPath: string;
	identity: DetachedJobOwnershipIdentity;
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
	identity: DetachedJobOwnershipIdentity;
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
	identity: DetachedJobOwnershipIdentity,
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

function isDetachedJobIdentity(value: unknown): value is DetachedJobOwnershipIdentity {
	if (!isRecord(value)) return false;
	return (
		typeof value.jobId === "string" &&
		isRecord(value.owner) &&
		typeof value.owner.sessionId === "string" &&
		(value.owner.agentId === null || typeof value.owner.agentId === "string") &&
		isRecord(value.processIdentity) &&
		Number.isSafeInteger(value.processIdentity.pid) &&
		Number.isSafeInteger(value.processIdentity.startTimeTicks) &&
		typeof value.outputLabel === "string"
	);
}

function commandIdentityMatches(
	command: StoredDetachedJobRuntimeCommand,
	current: DetachedJobOwnershipIdentity,
): boolean {
	const candidate = command.identity;
	return (
		candidate.jobId === current.jobId &&
		candidate.owner.sessionId === current.owner.sessionId &&
		candidate.owner.agentId === current.owner.agentId &&
		candidate.processIdentity.pid === current.processIdentity.pid &&
		candidate.processIdentity.startTimeTicks === current.processIdentity.startTimeTicks &&
		candidate.outputLabel === current.outputLabel
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
