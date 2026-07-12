import type { DetachedJobLeaseIdentity } from "./detached-job-runner.ts";
import {
	claimRuntimeMailboxMessages,
	deliverRuntimeMailboxMessage,
	failRuntimeMailboxMessage,
	type RuntimeMailboxAddress,
} from "./session-control-db.ts";

export interface DetachedJobCancelCommand {
	command: "cancel";
	identity: DetachedJobLeaseIdentity;
	reason?: string;
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

export type DetachedJobRuntimeCommand = DetachedJobCancelCommand | DetachedJobResponseCommand;

type StoredDetachedJobRuntimeCommand =
	| Omit<DetachedJobCancelCommand, "transportId">
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
