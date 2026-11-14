import { hostname } from "node:os";
import type { SqliteDatabase } from "../sqlite.ts";
import { withControlDb } from "./connection.ts";
import { parseProcessIdentity, withImmediateTransaction } from "./helpers.ts";
import {
	type CommitMultiAgentSteeringDeliveryInput,
	persistMultiAgentSteeringDelivery,
	prepareMultiAgentSteeringDelivery,
} from "./multi-agent-steering-delivery.ts";
import {
	compareAndDeleteCanonicalMailboxPayload,
	compareAndWriteSerializedCanonicalMailboxPayload,
	currentRuntimeOwnsMailboxAuthority,
	parseCanonicalMailboxPayload,
	RUNTIME_PROCESS_INSTANCE_ID,
	type RuntimeMailboxCandidate,
	readRuntimeMailboxAuthoritySnapshot,
	runtimeMailboxAuthoritySnapshotsEqual,
} from "./runtime-mailbox-enqueue.ts";
import { readCanonicalMailboxRowById, runtimeMailboxMessageFromCanonicalRow } from "./runtime-mailbox-status.ts";
import { readCanonicalMailboxRowsForRecipient } from "./shared-channel.ts";
import type { RuntimeMailboxAddress, RuntimeMailboxMessage } from "./types.ts";

export function takeRuntimeMailboxMessagesForDelivery(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
	isEligible: (message: RuntimeMailboxMessage) => boolean,
	limit = 20,
): RuntimeMailboxMessage[] {
	return withControlDb(controlDbPath, (db) => {
		const candidates = readEligibleRuntimeMailboxDeliveryCandidates(db, recipient, isEligible);
		return deliverRuntimeMailboxCandidates(db, recipient, candidates, limit, new Date().toISOString());
	});
}

/** Reports whether an eligible pending message exists without delivering it. */

export function hasPendingRuntimeMailboxMessage(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
	isEligible: (message: RuntimeMailboxMessage) => boolean,
): boolean {
	return withControlDb(
		controlDbPath,
		(db) => readEligibleRuntimeMailboxDeliveryCandidates(db, recipient, isEligible).length > 0,
	);
}

export function readEligibleRuntimeMailboxDeliveryCandidates(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	isEligible: (message: RuntimeMailboxMessage) => boolean,
): RuntimeMailboxCandidate[] {
	const rows = readCanonicalMailboxRowsForRecipient(db, recipient, "pending", Number.MAX_SAFE_INTEGER);
	return rows.flatMap((row) => {
		const authority = readRuntimeMailboxAuthoritySnapshot(db, recipient, row.session_path);
		if (!currentRuntimeOwnsMailboxAuthority(recipient, authority)) return [];
		const data = parseCanonicalMailboxPayload(row);
		const message = runtimeMailboxMessageFromCanonicalRow(row, data);
		return isEligible(message) ? [{ authority, data, row }] : [];
	});
}

export function deliverRuntimeMailboxCandidates(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	candidates: RuntimeMailboxCandidate[],
	limit: number,
	nowIso: string,
): RuntimeMailboxMessage[] {
	const deliveredMessages: RuntimeMailboxMessage[] = [];
	for (const candidate of candidates) {
		if (deliveredMessages.length === limit) break;
		const delivered = deliverRuntimeMailboxCandidate(db, recipient, candidate, nowIso);
		if (delivered) deliveredMessages.push(delivered);
	}
	return deliveredMessages;
}

export function deliverRuntimeMailboxCandidate(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	candidate: RuntimeMailboxCandidate,
	nowIso: string,
): RuntimeMailboxMessage | undefined {
	if (candidate.data.kind === "steer" && candidate.authority.ownership) {
		return deliverRuntimeMailboxSteeringCandidate(db, recipient, candidate, nowIso);
	}
	return claimRuntimeMailboxCandidate(db, recipient, candidate, nowIso);
}

export function deliverRuntimeMailboxSteeringCandidate(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	candidate: RuntimeMailboxCandidate,
	nowIso: string,
): RuntimeMailboxMessage | undefined {
	const ownership = candidate.authority.ownership;
	if (!ownership?.process_identity || !ownership.owner_session_id) return undefined;
	const input: CommitMultiAgentSteeringDeliveryInput = {
		agentId: ownership.agent_id,
		messageId: candidate.row.message_id,
		owner: { agentId: ownership.owner_agent_id, sessionId: ownership.owner_session_id },
		processIdentity: parseProcessIdentity(ownership.process_identity),
		requestedLifecycle: "running",
		sessionPath: candidate.row.session_path,
		updatedAt: nowIso,
	};
	const preflight = prepareMultiAgentSteeringDelivery(db, input);
	if ("result" in preflight || preflight.plan.messageData !== candidate.row.data) return undefined;
	const result = persistMultiAgentSteeringDelivery(db, input, preflight.plan, { recipient, candidate });
	return result?.ok
		? runtimeMailboxMessageFromCanonicalRow(candidate.row, {
				...candidate.data,
				status: "claimed",
				claimedAt: nowIso,
				updatedAt: nowIso,
			})
		: undefined;
}

export function claimRuntimeMailboxMessages(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
	limit = 20,
): RuntimeMailboxMessage[] {
	return withControlDb(controlDbPath, (db) => {
		const candidates = readClaimableRuntimeMailboxCandidates(db, recipient, limit);
		return claimRuntimeMailboxCandidates(db, recipient, candidates, new Date().toISOString());
	});
}

export function readClaimableRuntimeMailboxCandidates(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	limit: number,
): RuntimeMailboxCandidate[] {
	const rows = readCanonicalMailboxRowsForRecipient(db, recipient, "pending", limit);
	return rows.flatMap((row) => {
		const authority = readRuntimeMailboxAuthoritySnapshot(db, recipient, row.session_path);
		if (!currentRuntimeOwnsMailboxAuthority(recipient, authority)) return [];
		return [{ authority, data: parseCanonicalMailboxPayload(row), row }];
	});
}

export function claimRuntimeMailboxCandidates(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	candidates: RuntimeMailboxCandidate[],
	nowIso: string,
): RuntimeMailboxMessage[] {
	return candidates.flatMap((candidate) => {
		const claimed = claimRuntimeMailboxCandidate(db, recipient, candidate, nowIso);
		return claimed ? [claimed] : [];
	});
}

export function claimRuntimeMailboxCandidate(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	candidate: RuntimeMailboxCandidate,
	nowIso: string,
): RuntimeMailboxMessage | undefined {
	const claimed = {
		...candidate.data,
		claimedAt: nowIso,
		claimantProcessIdentity: RUNTIME_PROCESS_INSTANCE_ID,
		status: "claimed",
		updatedAt: nowIso,
	};
	const serialized = JSON.stringify(claimed);
	const updated = withImmediateTransaction(db, () => {
		const currentAuthority = readRuntimeMailboxAuthoritySnapshot(db, recipient, candidate.row.session_path);
		if (!runtimeMailboxAuthoritySnapshotsEqual(candidate.authority, currentAuthority)) return false;
		return compareAndWriteSerializedCanonicalMailboxPayload(db, candidate.row, serialized, nowIso);
	});
	return updated ? runtimeMailboxMessageFromCanonicalRow(candidate.row, claimed) : undefined;
}

export function readRuntimeMailboxMessageForDelivery(
	controlDbPath: string,
	id: number,
): { message: RuntimeMailboxMessage; payloadData?: string; payloadValid: boolean } | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = readCanonicalMailboxRowById(db, id);
		if (!row) return undefined;
		const message = parseCanonicalMailboxPayload(row);
		return {
			message: runtimeMailboxMessageFromCanonicalRow(row, message),
			payloadData: row.data,
			payloadValid: message.status === "claimed" && message.claimantProcessIdentity === RUNTIME_PROCESS_INSTANCE_ID,
		};
	});
}

export function deliverRuntimeMailboxMessage(controlDbPath: string, id: number, expectedPayloadData?: string): boolean {
	return withControlDb(controlDbPath, (db) => {
		const row = readCanonicalMailboxRowById(db, id);
		if (!row) return false;
		const message = parseCanonicalMailboxPayload(row);
		if (message.recipientHost && message.recipientHost !== hostname()) return false;
		if (message.status !== "claimed" || message.claimantProcessIdentity !== RUNTIME_PROCESS_INSTANCE_ID) return false;
		if (expectedPayloadData !== undefined && row.data !== expectedPayloadData) return false;
		return withImmediateTransaction(db, () => compareAndDeleteCanonicalMailboxPayload(db, row));
	});
}
