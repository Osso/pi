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

interface StoredDetachedJobControlCommand {
	command: "cancel";
	identity: DetachedJobLeaseIdentity;
	reason?: string;
}

export function claimDetachedJobControlCommands(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
	identity: DetachedJobLeaseIdentity,
): DetachedJobCancelCommand[] {
	const commands: DetachedJobCancelCommand[] = [];
	for (const message of claimRuntimeMailboxMessages(controlDbPath, recipient)) {
		const command = parseControlCommand(message.body);
		if (!command || !sameLeaseIdentity(command.identity, identity)) {
			failRuntimeMailboxMessage(controlDbPath, message.id, "Detached job control identity mismatch");
			continue;
		}
		if (!deliverRuntimeMailboxMessage(controlDbPath, message.id)) {
			failRuntimeMailboxMessage(controlDbPath, message.id, "Detached job control delivery failed");
			continue;
		}
		commands.push({
			command: command.command,
			identity: command.identity,
			reason: command.reason,
			transportId: message.id,
		});
	}
	return commands;
}

function parseControlCommand(body: string): StoredDetachedJobControlCommand | undefined {
	try {
		const parsed = JSON.parse(body) as unknown;
		if (!isRecord(parsed) || parsed.command !== "cancel" || !isRecord(parsed.identity)) return undefined;
		const identity = parsed.identity;
		if (
			typeof identity.jobId !== "string" ||
			typeof identity.expectedRevision !== "number" ||
			typeof identity.leaseId !== "string" ||
			typeof identity.runtimeIncarnation !== "string" ||
			typeof identity.fencingEpoch !== "number" ||
			typeof identity.outputLabel !== "string"
		) {
			return undefined;
		}
		return {
			command: "cancel",
			identity: identity as unknown as DetachedJobLeaseIdentity,
			reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
		};
	} catch {
		return undefined;
	}
}

function sameLeaseIdentity(left: DetachedJobLeaseIdentity, right: DetachedJobLeaseIdentity): boolean {
	return (
		left.jobId === right.jobId &&
		left.expectedRevision === right.expectedRevision + 1 &&
		left.leaseId === right.leaseId &&
		left.runtimeIncarnation === right.runtimeIncarnation &&
		left.fencingEpoch === right.fencingEpoch &&
		left.outputLabel === right.outputLabel
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
