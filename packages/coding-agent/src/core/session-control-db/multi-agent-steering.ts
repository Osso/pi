import type { AgentFileReference, AgentMailboxMessage, AgentSnapshot } from "../multi-agent-store.ts";
import { isProcessIdentityAlive } from "../runtime-process.ts";
import type { SqliteDatabase } from "../sqlite.ts";
import { parseStoredJsonObject, validatePersistedAgentPayload } from "./codecs.ts";
import { withControlDb } from "./connection.ts";
import { runtimeOwnerMatches, serializeProcessIdentity } from "./detached-job-finalization.ts";
import { parseProcessIdentity, withImmediateTransaction } from "./helpers.ts";
import { type CommitMultiAgentLifecycleMutationInput, canPersistLifecycleTransition } from "./multi-agent-lifecycle.ts";
import { allocateMultiAgentCounterWithDb } from "./multi-agent-state.ts";
import {
	assertMailboxMessageFresh,
	type MultiAgentRuntimeOwnershipRow,
	prepareStoredRuntimeMailboxMessage,
	RUNTIME_PROCESS_INSTANCE_ID,
	readMultiAgentRuntimeOwnershipRow,
	readRuntimeMailboxListenerRow,
} from "./runtime-mailbox-enqueue.ts";
import { trustedRuntimeMailboxSessionPath } from "./runtime-mailbox-registration.ts";
import type {
	EnqueueStoredRuntimeMailboxMessageInput,
	RuntimeMailboxAddress,
	RuntimeMailboxListenerRow,
} from "./types.ts";

export interface CommitMultiAgentSteeringMutationInput extends CommitMultiAgentLifecycleMutationInput {
	body: string;
	fileRefs?: AgentFileReference[];
	fromAgentId: string;
	recipient: RuntimeMailboxAddress;
	targetCheckpoint?: AgentMailboxMessage["targetCheckpoint"];
	threadId?: string;
}

export type CommitMultiAgentSteeringMutationResult =
	| { ok: true; agent: AgentSnapshot; message: AgentMailboxMessage }
	| { ok: false; error: "agent_not_found" | "invalid_transition" | "mutation_mismatch" };

export const MULTI_AGENT_STEERING_MUTATION_MAX_ATTEMPTS = 3;

export type MultiAgentSteeringMutationPlan = {
	agentData: string;
	mailbox: PreparedSteeringMailboxMessage;
	processIdentityData: string;
	recipientListener: RuntimeMailboxListenerRow;
	senderListener: RuntimeMailboxListenerRow;
	updatedAgent: AgentSnapshot;
	updatedAgentData: string;
};

export type MultiAgentSteeringMutationPreflight =
	| { plan: MultiAgentSteeringMutationPlan }
	| { result: CommitMultiAgentSteeringMutationResult };

export const STEERING_MESSAGE_ID_PLACEHOLDER = "__pi_generated_steering_message_id__";

export type PreparedSteeringMailboxMessage = {
	dataPrefix: string;
	dataSuffix: string;
	updatedAt: string;
};

export function commitMultiAgentSteeringMutation(
	controlDbPath: string,
	input: CommitMultiAgentSteeringMutationInput,
): CommitMultiAgentSteeringMutationResult {
	return withControlDb(controlDbPath, (db) => {
		for (let attempt = 1; attempt <= MULTI_AGENT_STEERING_MUTATION_MAX_ATTEMPTS; attempt += 1) {
			const preflight = prepareMultiAgentSteeringMutation(db, input);
			if ("result" in preflight) return preflight.result;
			const result = persistMultiAgentSteeringMutation(db, input, preflight.plan);
			if (result) return result;
		}
		return { ok: false, error: "mutation_mismatch" };
	});
}

export function prepareMultiAgentSteeringMutation(
	db: SqliteDatabase,
	input: CommitMultiAgentSteeringMutationInput,
): MultiAgentSteeringMutationPreflight {
	const agentRow = readSteeringMutationAgent(db, input);
	if (!agentRow) return { result: { ok: false, error: "agent_not_found" } };
	if (
		input.requestedLifecycle !== "steering_pending" ||
		!canPersistLifecycleTransition(agentRow.agent.lifecycle, input.requestedLifecycle)
	) {
		return { result: { ok: false, error: "invalid_transition" } };
	}
	const ownership = readMultiAgentRuntimeOwnershipRow(db, input.sessionPath, input.agentId);
	const senderListener = readRuntimeMailboxListenerRow(db, {
		agentId: input.owner.agentId,
		sessionId: input.owner.sessionId,
	});
	const recipientListener = readRuntimeMailboxListenerRow(db, input.recipient);
	if (!senderListener || !recipientListener) return { result: { ok: false, error: "mutation_mismatch" } };
	if (!steeringMutationHasAuthority(agentRow.agent, ownership, senderListener, recipientListener, input)) {
		return { result: { ok: false, error: "mutation_mismatch" } };
	}
	const updatedAgent: AgentSnapshot = {
		...agentRow.agent,
		lifecycle: input.requestedLifecycle,
		revision: agentRow.agent.revision + 1,
		updatedAt: input.updatedAt,
	};
	return {
		plan: {
			agentData: agentRow.data,
			mailbox: prepareSteeringMailboxMessage(input),
			processIdentityData: serializeProcessIdentity(input.processIdentity),
			recipientListener,
			senderListener,
			updatedAgent,
			updatedAgentData: JSON.stringify(updatedAgent),
		},
	};
}

export function readSteeringMutationAgent(
	db: SqliteDatabase,
	input: CommitMultiAgentSteeringMutationInput,
): { agent: AgentSnapshot; data: string } | undefined {
	const row = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(input.sessionPath, input.agentId) as { data: string } | undefined;
	if (!row) return undefined;
	const context = `multi_agent_agents:${input.sessionPath}#${input.agentId}`;
	const agent = parseStoredJsonObject(row.data, context);
	validatePersistedAgentPayload(agent, context);
	return { agent: agent as unknown as AgentSnapshot, data: row.data };
}

export function steeringMutationHasAuthority(
	agent: AgentSnapshot,
	ownership: MultiAgentRuntimeOwnershipRow | undefined,
	senderListener: RuntimeMailboxListenerRow,
	recipientListener: RuntimeMailboxListenerRow,
	input: CommitMultiAgentSteeringMutationInput,
): boolean {
	if (!runtimeOwnerMatches(ownership, input)) return false;
	const senderPathMatches =
		input.owner.agentId !== null || trustedRuntimeMailboxSessionPath(senderListener) === input.sessionPath;
	const expectedSenderId = input.owner.agentId ?? "supervisor";
	return (
		input.fromAgentId === expectedSenderId &&
		agent.parentId === (input.owner.agentId ?? "main") &&
		input.recipient.agentId === input.agentId &&
		input.recipient.sessionId === agent.transcript?.sessionId &&
		senderListener.pid === process.pid &&
		senderListener.runtime_instance_id === RUNTIME_PROCESS_INSTANCE_ID &&
		senderPathMatches &&
		runtimeListenerMatchesProcessIdentity(recipientListener, ownership?.process_identity)
	);
}

export function persistMultiAgentSteeringMutation(
	db: SqliteDatabase,
	input: CommitMultiAgentSteeringMutationInput,
	plan: MultiAgentSteeringMutationPlan,
): CommitMultiAgentSteeringMutationResult | undefined {
	const messageNumber = withImmediateTransaction(db, () => {
		if (!compareAndPersistSteeringAgent(db, input, plan)) return undefined;
		const allocatedMessageNumber = allocateMultiAgentCounterWithDb(db, input.sessionPath, "message");
		const messageId = `message_${allocatedMessageNumber}`;
		persistPreparedSteeringMailboxMessage(db, input.sessionPath, messageId, plan.mailbox);
		return allocatedMessageNumber;
	});
	if (messageNumber === undefined) return undefined;
	return {
		agent: plan.updatedAgent,
		message: buildSteeringMailboxMessage(input, `message_${messageNumber}`),
		ok: true,
	};
}

export function compareAndPersistSteeringAgent(
	db: SqliteDatabase,
	input: CommitMultiAgentSteeringMutationInput,
	plan: MultiAgentSteeringMutationPlan,
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
				 )
				 AND EXISTS (
					SELECT 1 FROM runtime_mailbox_listeners
					WHERE recipient_session_id = ? AND recipient_agent_id_key = ? AND pid = ?
					AND runtime_instance_id IS ? AND session_path IS ?
					AND session_path_asserted_at IS ? AND updated_at = ?
				 )
				 AND EXISTS (
					SELECT 1 FROM runtime_mailbox_listeners
					WHERE recipient_session_id = ? AND recipient_agent_id_key = ? AND pid = ?
					AND runtime_instance_id IS ? AND session_path IS ?
					AND session_path_asserted_at IS ? AND updated_at = ?
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
				input.owner.sessionId,
				input.owner.agentId ?? "",
				plan.senderListener.pid,
				plan.senderListener.runtime_instance_id,
				plan.senderListener.session_path,
				plan.senderListener.session_path_asserted_at,
				plan.senderListener.updated_at,
				input.recipient.sessionId,
				input.recipient.agentId ?? "",
				plan.recipientListener.pid,
				plan.recipientListener.runtime_instance_id,
				plan.recipientListener.session_path,
				plan.recipientListener.session_path_asserted_at,
				plan.recipientListener.updated_at,
			).changes === 1
	);
}

export function buildSteeringMailboxMessage(
	input: CommitMultiAgentSteeringMutationInput,
	messageId: string,
): AgentMailboxMessage {
	return {
		body: input.body,
		createdAt: input.updatedAt,
		fileRefs: input.fileRefs,
		fromAgentId: input.fromAgentId,
		id: messageId,
		kind: "steer",
		status: "pending",
		targetCheckpoint: input.targetCheckpoint,
		threadId: input.threadId,
		toAgentId: input.agentId,
		updatedAt: input.updatedAt,
	};
}

export function prepareSteeringMailboxMessage(
	input: CommitMultiAgentSteeringMutationInput,
): PreparedSteeringMailboxMessage {
	const message = buildSteeringMailboxMessage(input, STEERING_MESSAGE_ID_PLACEHOLDER);
	const mailboxInput: EnqueueStoredRuntimeMailboxMessageInput = {
		kind: message.kind,
		message,
		recipient: input.recipient,
		sender: input.owner,
		storeRef: { messageId: message.id, sessionPath: input.sessionPath },
		updatedAt: input.updatedAt,
	};
	const serialized = prepareStoredRuntimeMailboxMessage(mailboxInput).serialized;
	const serializedId = JSON.stringify(STEERING_MESSAGE_ID_PLACEHOLDER);
	const idProperty = `"id":${serializedId}`;
	const idPropertyIndex = serialized.indexOf(idProperty);
	if (idPropertyIndex < 0 || serialized.indexOf(idProperty, idPropertyIndex + idProperty.length) >= 0) {
		throw new Error("Prepared steering mailbox payload has an invalid generated message ID field");
	}
	const serializedIdIndex = idPropertyIndex + `"id":`.length;
	return {
		dataPrefix: serialized.slice(0, serializedIdIndex),
		dataSuffix: serialized.slice(serializedIdIndex + serializedId.length),
		updatedAt: input.updatedAt,
	};
}

export function persistPreparedSteeringMailboxMessage(
	db: SqliteDatabase,
	sessionPath: string,
	messageId: string,
	prepared: PreparedSteeringMailboxMessage,
): void {
	assertMailboxMessageFresh(
		{ createdAt: prepared.updatedAt },
		`multi_agent_mailbox_messages:${sessionPath}#${messageId}`,
	);
	db.prepare(
		`INSERT INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at)
		 VALUES (?, ?, ? || json_quote(?) || ?, ?)`,
	).run(sessionPath, messageId, prepared.dataPrefix, messageId, prepared.dataSuffix, prepared.updatedAt);
}

export function runtimeListenerMatchesProcessIdentity(
	listener: RuntimeMailboxListenerRow | undefined,
	serializedIdentity: string | null | undefined,
): boolean {
	if (!listener?.runtime_instance_id || !serializedIdentity) return false;
	try {
		const listenerIdentity = parseProcessIdentity(listener.runtime_instance_id);
		const processIdentity = parseProcessIdentity(serializedIdentity);
		return (
			listener.pid === processIdentity.pid &&
			listenerIdentity.pid === processIdentity.pid &&
			listenerIdentity.startTimeTicks === processIdentity.startTimeTicks &&
			isProcessIdentityAlive(processIdentity)
		);
	} catch {
		return false;
	}
}
