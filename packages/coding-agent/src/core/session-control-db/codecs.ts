import { hostname } from "node:os";
import { isAbsolute } from "node:path";
import type {
	AgentFileReference,
	EnqueueRuntimeMailboxMessageInput,
	RuntimeMailboxMessage,
	RuntimeMailboxMessageKind,
	RuntimeMailboxMessageStatus,
} from "./types.ts";

export function addRuntimeMailboxRouting(
	message: Record<string, unknown>,
	input: EnqueueRuntimeMailboxMessageInput,
): Record<string, unknown> {
	assertRuntimeMailboxRouting(message, input);
	return {
		...message,
		...(input.recipientHost ? { recipientHost: input.recipientHost } : {}),
		recipientSessionId: input.recipient.sessionId,
		recipientAgentId: input.recipient.agentId,
		senderSessionId: input.sender.sessionId,
		senderAgentId: input.sender.agentId,
	};
}

export function assertRuntimeMailboxRouting(
	message: Record<string, unknown>,
	input: EnqueueRuntimeMailboxMessageInput,
): void {
	const hasRouting = typeof message.recipientSessionId === "string";
	if (!hasRouting) return;
	const sameRecipient =
		message.recipientSessionId === input.recipient.sessionId && message.recipientAgentId === input.recipient.agentId;
	const sameSender =
		message.senderSessionId === input.sender.sessionId && message.senderAgentId === input.sender.agentId;
	const sameHost = (message.recipientHost ?? hostname()) === (input.recipientHost || hostname());
	if (sameRecipient && sameSender && sameHost && message.kind === input.kind) return;
	throw new Error(
		`Runtime mailbox store reference conflicts with canonical mailbox row: ${input.storeRef.sessionPath}#${input.storeRef.messageId}`,
	);
}

export function stripRuntimeMailboxDeliveryState(serialized: string, omitDefaultedBirth: boolean): string {
	const message = parseStoredJsonObject(serialized, "runtime_mailbox_identity");
	const { claimedAt, claimantProcessIdentity, error, status, updatedAt, ...identity } = message;
	void claimedAt;
	void claimantProcessIdentity;
	void error;
	void status;
	void updatedAt;
	if (omitDefaultedBirth) delete identity.createdAt;
	return JSON.stringify(identity);
}

export function nullableStringField(message: Record<string, unknown>, field: string, context: string): string | null {
	const value = message[field];
	if (value === null) return null;
	if (typeof value === "string") return value;
	throw new Error(`Invalid ${field} at ${context}`);
}

export function optionalStringField(
	message: Record<string, unknown>,
	field: string,
	context: string,
): string | undefined {
	const value = message[field];
	if (value === undefined) return undefined;
	if (typeof value === "string") return value;
	throw new Error(`Invalid ${field} at ${context}`);
}

export function toRuntimeMailboxMessageKind(value: string): RuntimeMailboxMessageKind {
	if (
		value === "message" ||
		value === "ask" ||
		value === "reply" ||
		value === "steer" ||
		value === "parent_request" ||
		value === "system"
	) {
		return value;
	}
	return "message";
}

export function toRuntimeMailboxMessageStatus(value: string): RuntimeMailboxMessageStatus {
	if (value === "pending" || value === "claimed" || value === "failed") {
		return value;
	}
	return "failed";
}

export function parseSteeringCheckpoint(value: unknown, context: string): RuntimeMailboxMessage["targetCheckpoint"] {
	if (value === undefined) return undefined;
	if (value === "next_model_call" || value === "after_tool_result" || value === "when_waiting") return value;
	throw new Error(`Invalid steering checkpoint at ${context}`);
}

export function parseFileRefs(value: unknown, context: string): AgentFileReference[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		throw new Error(`Invalid file references at ${context}: expected an array`);
	}
	return value.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new Error(`Invalid file reference at ${context}[${index}]`);
		}
		const ref = item as { path?: unknown; label?: unknown };
		if (typeof ref.path !== "string" || !isAbsolute(ref.path)) {
			throw new Error(`Invalid file reference at ${context}[${index}]: path must be absolute`);
		}
		if (ref.label !== undefined && typeof ref.label !== "string") {
			throw new Error(`Invalid file reference at ${context}[${index}]: label must be a string`);
		}
		return {
			path: ref.path,
			label: ref.label,
		};
	});
}

export function validateMailboxPayload(data: unknown, context: string): void {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error(`Invalid persisted mailbox payload at ${context}`);
	}
	const payload = data as Record<string, unknown>;
	if (Object.keys(payload).length === 0) {
		throw new Error(`Invalid persisted mailbox payload at ${context}: expected fields`);
	}
	rejectLegacyArtifactFields(data, context);
	for (const field of ["id", "fromAgentId", "toAgentId", "kind", "status", "createdAt", "updatedAt"] as const) {
		if (field === "createdAt" && payload[field] === null) continue;
		if (payload[field] !== undefined) {
			requireStringField(payload, field, context);
		}
	}
	if (payload.body !== undefined) {
		requireStringField(payload, "body", context);
	}
	parseFileRefs(payload.fileRefs, context);
	parseSteeringCheckpoint(payload.targetCheckpoint, context);
}

export function validatePersistedAgentPayload(data: Record<string, unknown>, context: string): void {
	if (Object.keys(data).length === 0) {
		throw new Error(`Invalid persisted agent payload at ${context}: expected fields`);
	}
	rejectLegacyArtifactFields(data, context);
	validatePersistedAgentRevisionAndNotificationPolicy(data, context);
	if (data.permission !== undefined) {
		if (!data.permission || typeof data.permission !== "object" || Array.isArray(data.permission)) {
			throw new Error(`Invalid persisted permission at ${context}`);
		}
		const permission = data.permission as Record<string, unknown>;
		requireStringField(permission, "policy", `${context}.permission`);
		if (typeof permission.narrowed !== "boolean") {
			throw new Error(`Invalid persisted narrowed at ${context}.permission: expected a boolean`);
		}
	}
	const result = data.result;
	if (result !== undefined) {
		if (!result || typeof result !== "object" || Array.isArray(result)) {
			throw new Error(`Invalid persisted agent result at ${context}`);
		}
		parseFileRefs((result as Record<string, unknown>).fileRefs, `${context}.result`);
	}
}

export function validatePersistedAgentRevisionAndNotificationPolicy(
	data: Record<string, unknown>,
	context: string,
): void {
	if (
		data.revision !== undefined &&
		(typeof data.revision !== "number" || !Number.isInteger(data.revision) || data.revision < 0)
	) {
		throw new Error(`Invalid persisted revision at ${context}: expected a non-negative integer`);
	}
	if (data.suppressTerminalNotification !== undefined && typeof data.suppressTerminalNotification !== "boolean") {
		throw new Error(`Invalid persisted suppressTerminalNotification at ${context}: expected a boolean`);
	}
}

export function rejectLegacyArtifactFields(value: unknown, context: string): void {
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			rejectLegacyArtifactFields(item, `${context}[${index}]`);
		}
		return;
	}
	if (!value || typeof value !== "object") {
		return;
	}
	for (const [key, nested] of Object.entries(value)) {
		if (key === "artifactIds" || key === "artifactRefs") {
			throw new Error(`Legacy artifact fields are not supported at ${context}.${key}`);
		}
		rejectLegacyArtifactFields(nested, `${context}.${key}`);
	}
}

export function parseStoredJsonObject(value: string, context: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value) as unknown;
	} catch (error) {
		throw new Error(`Invalid persisted JSON at ${context}`, { cause: error });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Invalid persisted object at ${context}`);
	}
	return parsed as Record<string, unknown>;
}

export function requireStringField(data: Record<string, unknown>, field: string, context: string): string {
	if (typeof data[field] !== "string") {
		throw new Error(`Invalid persisted ${field} at ${context}: expected a string`);
	}
	return data[field];
}

export function parseJsonObject(value: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

export function isNonterminalLifecycle(lifecycle: unknown): boolean {
	return typeof lifecycle === "string" && !["completed", "failed", "aborted"].includes(lifecycle);
}

export function arraysEqual<T>(expected: T[], current: T[]): boolean {
	return expected.length === current.length && expected.every((value, index) => value === current[index]);
}

export function stripLegacyArtifactFields(value: unknown): { value: unknown; changed: boolean } {
	if (Array.isArray(value)) {
		let changed = false;
		const migrated = value.map((item) => {
			const result = stripLegacyArtifactFields(item);
			changed ||= result.changed;
			return result.value;
		});
		return { value: changed ? migrated : value, changed };
	}
	if (!value || typeof value !== "object") return { value, changed: false };

	let changed = false;
	const migratedEntries: Array<[string, unknown]> = [];
	for (const [key, nested] of Object.entries(value)) {
		if (key === "artifactIds" || key === "artifactRefs") {
			changed = true;
			continue;
		}
		const result = stripLegacyArtifactFields(nested);
		changed ||= result.changed;
		migratedEntries.push([key, result.value]);
	}
	return { value: changed ? Object.fromEntries(migratedEntries) : value, changed };
}
