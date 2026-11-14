import { isMailboxMessageExpired, MAILBOX_MESSAGE_RETENTION_MS } from "../mailbox-retention.ts";
import type { AgentMailboxMessage, AgentSnapshot } from "../multi-agent-store.ts";
import type { ProcessIdentity } from "../runtime-process.ts";
import type { SqliteDatabase } from "../sqlite.ts";
import { parseStoredJsonObject, validateMailboxPayload, validatePersistedAgentPayload } from "./codecs.ts";
import { withControlDb } from "./connection.ts";
import { runtimeOwnerMatches, serializeProcessIdentity } from "./detached-job-finalization.ts";
import { isRecoverableRuntimeLifecycle } from "./detached-job-recovery.ts";
import { withImmediateTransaction } from "./helpers.ts";
import { type CommitMultiAgentLifecycleMutationInput, canPersistLifecycleTransition } from "./multi-agent-lifecycle.ts";
import {
	compareAndWriteSerializedCanonicalMailboxPayload,
	RUNTIME_PROCESS_INSTANCE_ID,
	type RuntimeMailboxCandidate,
	readMultiAgentRuntimeOwnershipRow,
	readRuntimeMailboxAuthoritySnapshot,
	runtimeMailboxAuthoritySnapshotsEqual,
} from "./runtime-mailbox-enqueue.ts";
import { MAILBOX_CREATED_AT_MS_SQL, type RuntimeMailboxAddress } from "./types.ts";

export interface CommitMultiAgentSteeringDeliveryInput extends CommitMultiAgentLifecycleMutationInput {
	messageId: string;
}

export type CommitMultiAgentSteeringDeliveryResult =
	| { ok: true; agent: AgentSnapshot; message: AgentMailboxMessage }
	| {
			ok: false;
			error: "agent_not_found" | "invalid_transition" | "message_not_found" | "mutation_mismatch";
	  };

export interface CommitMultiAgentDetachMarkInput {
	agentId: string;
	owner: { agentId: string | null; sessionId: string };
	processIdentity: ProcessIdentity;
	sessionPath: string;
	updatedAt: string;
}

export type CommitMultiAgentDetachMarkResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: "agent_not_found" | "invalid_transition" | "mutation_mismatch" };

export const MULTI_AGENT_DETACH_MARK_MAX_ATTEMPTS = 3;

export type MultiAgentDetachMarkPreflight =
	| { plan: { agentData: string; updatedAgent: AgentSnapshot } }
	| { result: CommitMultiAgentDetachMarkResult };

/**
 * Mark an owned background job as detached from its waiting tool call.
 * Only detached jobs emit a terminal runtime-mailbox notification; attended
 * jobs deliver their result in-band through the waiting tool call.
 */

export function commitMultiAgentDetachMark(
	controlDbPath: string,
	input: CommitMultiAgentDetachMarkInput,
): CommitMultiAgentDetachMarkResult {
	return withControlDb(controlDbPath, (db) => {
		for (let attempt = 1; attempt <= MULTI_AGENT_DETACH_MARK_MAX_ATTEMPTS; attempt += 1) {
			const preflight = prepareMultiAgentDetachMark(db, input);
			if ("result" in preflight) return preflight.result;
			if (compareAndPersistMultiAgentDetachMark(db, input, preflight.plan)) {
				return { agent: preflight.plan.updatedAgent, ok: true };
			}
		}
		return { ok: false, error: "mutation_mismatch" };
	});
}

export function prepareMultiAgentDetachMark(
	db: SqliteDatabase,
	input: CommitMultiAgentDetachMarkInput,
): MultiAgentDetachMarkPreflight {
	const row = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(input.sessionPath, input.agentId) as { data: string } | undefined;
	if (!row) return { result: { ok: false, error: "agent_not_found" } };
	const context = `multi_agent_agents:${input.sessionPath}#${input.agentId}`;
	const agent = parseStoredJsonObject(row.data, context);
	validatePersistedAgentPayload(agent, context);
	const ownership = readMultiAgentRuntimeOwnershipRow(db, input.sessionPath, input.agentId);
	if (!runtimeOwnerMatches(ownership, input)) return { result: { ok: false, error: "mutation_mismatch" } };
	if (!isRecoverableRuntimeLifecycle(agent.lifecycle)) {
		return { result: { ok: false, error: "invalid_transition" } };
	}
	if (agent.detached === true) {
		return { result: { ok: true, agent: agent as unknown as AgentSnapshot } };
	}
	const updatedAgent = {
		...agent,
		detached: true,
		revision: Number(agent.revision) + 1,
		updatedAt: input.updatedAt,
	};
	validatePersistedAgentPayload(updatedAgent, context);
	return { plan: { agentData: row.data, updatedAgent: updatedAgent as unknown as AgentSnapshot } };
}

export function compareAndPersistMultiAgentDetachMark(
	db: SqliteDatabase,
	input: CommitMultiAgentDetachMarkInput,
	plan: { agentData: string; updatedAgent: AgentSnapshot },
): boolean {
	return (
		db
			.prepare(
				`UPDATE multi_agent_agents SET data = ?, updated_at = ?
				 WHERE session_path = ? AND agent_id = ? AND data = ?
				 AND EXISTS (
					SELECT 1 FROM multi_agent_runtime_owners
					WHERE session_path = ? AND agent_id = ? AND process_identity = ?
					AND owner_session_id = ? AND owner_agent_id IS ?
				 )`,
			)
			.run(
				JSON.stringify(plan.updatedAgent),
				input.updatedAt,
				input.sessionPath,
				input.agentId,
				plan.agentData,
				input.sessionPath,
				input.agentId,
				serializeProcessIdentity(input.processIdentity),
				input.owner.sessionId,
				input.owner.agentId,
			).changes === 1
	);
}

export const MULTI_AGENT_STEERING_DELIVERY_MAX_ATTEMPTS = 3;

export type MultiAgentSteeringDeliveryPlan = {
	agentData: string;
	messageData: string;
	processIdentityData: string;
	updatedAgent: AgentSnapshot;
	updatedAgentData: string;
	updatedMessage: AgentMailboxMessage;
};

export type MultiAgentSteeringDeliveryPreflight =
	| { plan: MultiAgentSteeringDeliveryPlan }
	| { result: CommitMultiAgentSteeringDeliveryResult };

export function commitMultiAgentSteeringDelivery(
	controlDbPath: string,
	input: CommitMultiAgentSteeringDeliveryInput,
): CommitMultiAgentSteeringDeliveryResult {
	return withControlDb(controlDbPath, (db) => {
		for (let attempt = 1; attempt <= MULTI_AGENT_STEERING_DELIVERY_MAX_ATTEMPTS; attempt += 1) {
			const preflight = prepareMultiAgentSteeringDelivery(db, input);
			if ("result" in preflight) return preflight.result;
			const result = persistMultiAgentSteeringDelivery(db, input, preflight.plan);
			if (result) return result;
		}
		return { ok: false, error: "mutation_mismatch" };
	});
}

export function prepareMultiAgentSteeringDelivery(
	db: SqliteDatabase,
	input: CommitMultiAgentSteeringDeliveryInput,
): MultiAgentSteeringDeliveryPreflight {
	const agentRow = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(input.sessionPath, input.agentId) as { data: string } | undefined;
	if (!agentRow) return { result: { ok: false, error: "agent_not_found" } };
	const agentContext = `multi_agent_agents:${input.sessionPath}#${input.agentId}`;
	const agent = parseStoredJsonObject(agentRow.data, agentContext);
	validatePersistedAgentPayload(agent, agentContext);
	const ownership = readMultiAgentRuntimeOwnershipRow(db, input.sessionPath, input.agentId);
	if (!runtimeOwnerMatches(ownership, input)) {
		return { result: { ok: false, error: "mutation_mismatch" } };
	}
	if (!canPersistLifecycleTransition(agent.lifecycle, input.requestedLifecycle)) {
		return { result: { ok: false, error: "invalid_transition" } };
	}
	const messageRow = db
		.prepare(`SELECT data FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?
			AND ${MAILBOX_CREATED_AT_MS_SQL} > ?`)
		.get(input.sessionPath, input.messageId, Date.now() - MAILBOX_MESSAGE_RETENTION_MS) as
		| { data: string }
		| undefined;
	if (!messageRow) return { result: { ok: false, error: "message_not_found" } };
	const messageContext = `multi_agent_mailbox_messages:${input.sessionPath}#${input.messageId}`;
	const message = parseStoredJsonObject(messageRow.data, messageContext);
	validateMailboxPayload(message, messageContext);
	if (message.kind !== "steer" || message.toAgentId !== input.agentId) {
		return { result: { ok: false, error: "message_not_found" } };
	}
	const updatedAgent = {
		...agent,
		lifecycle: input.requestedLifecycle,
		revision: Number(agent.revision) + 1,
		updatedAt: input.updatedAt,
	} as unknown as AgentSnapshot;
	const updatedMessage = message as unknown as AgentMailboxMessage;
	return {
		plan: {
			agentData: agentRow.data,
			messageData: messageRow.data,
			processIdentityData: serializeProcessIdentity(input.processIdentity),
			updatedAgent,
			updatedAgentData: JSON.stringify(updatedAgent),
			updatedMessage,
		},
	};
}

export function persistMultiAgentSteeringDelivery(
	db: SqliteDatabase,
	input: CommitMultiAgentSteeringDeliveryInput,
	plan: MultiAgentSteeringDeliveryPlan,
	mailbox?: { recipient: RuntimeMailboxAddress; candidate: RuntimeMailboxCandidate },
): CommitMultiAgentSteeringDeliveryResult | undefined {
	const claimedPayload = mailbox
		? JSON.stringify({
				...mailbox.candidate.data,
				status: "claimed",
				claimedAt: input.updatedAt,
				claimantProcessIdentity: RUNTIME_PROCESS_INSTANCE_ID,
				updatedAt: input.updatedAt,
			})
		: undefined;
	const persisted = withImmediateTransaction(db, () => {
		if (isMailboxMessageExpired(plan.updatedMessage.createdAt, Date.now())) return false;
		if (mailbox) {
			const authority = readRuntimeMailboxAuthoritySnapshot(db, mailbox.recipient, input.sessionPath);
			if (!runtimeMailboxAuthoritySnapshotsEqual(mailbox.candidate.authority, authority)) return false;
		}
		const agentUpdated = db
			.prepare(
				`UPDATE multi_agent_agents SET data = ?, updated_at = ?
				 WHERE session_path = ? AND agent_id = ? AND data = ?
				 AND EXISTS (
					SELECT 1 FROM multi_agent_runtime_owners
					WHERE session_path = ? AND agent_id = ? AND process_identity = ?
					AND owner_session_id = ? AND owner_agent_id IS ?
				 )
				 AND EXISTS (
					SELECT 1 FROM multi_agent_mailbox_messages
					WHERE session_path = ? AND message_id = ? AND data = ?
				 )`,
			)
			.run(
				plan.updatedAgentData,
				input.updatedAt,
				input.sessionPath,
				input.agentId,
				plan.agentData,
				input.sessionPath,
				input.agentId,
				plan.processIdentityData,
				input.owner.sessionId,
				input.owner.agentId,
				input.sessionPath,
				input.messageId,
				plan.messageData,
			).changes;
		if (agentUpdated !== 1) return false;
		const messageUpdated =
			mailbox && claimedPayload !== undefined
				? Number(
						compareAndWriteSerializedCanonicalMailboxPayload(
							db,
							mailbox.candidate.row,
							claimedPayload,
							input.updatedAt,
						),
					)
				: db
						.prepare(`DELETE FROM multi_agent_mailbox_messages
				 WHERE session_path = ? AND message_id = ? AND data = ?`)
						.run(input.sessionPath, input.messageId, plan.messageData).changes;
		if (messageUpdated !== 1) {
			throw new Error(`Steering message changed during delivery ${input.sessionPath}#${input.messageId}`);
		}
		return true;
	});
	return persisted ? { agent: plan.updatedAgent, message: plan.updatedMessage, ok: true } : undefined;
}
