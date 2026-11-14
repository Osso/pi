import type { AgentToolResult, ExtensionContext } from "../../../src/core/extensions/types.ts";
import type {
	AgentLifecycleState,
	AgentMailboxMessage,
	AgentSnapshot,
	MultiAgentStore,
} from "../../../src/core/multi-agent-store.ts";
import { isActiveLifecycle } from "../../../src/core/multi-agent-store.ts";
import { enqueueRuntimeMailboxMessage, type RuntimeMailboxAddress } from "../../../src/core/session-control-db.ts";
import {
	MAIN_THREAD_AGENT_ID,
	type MultiAgentExtensionOptions,
	type SendAgentMessageToolDetails,
} from "./contracts.ts";
import type { SendAgentMessageParams } from "./mailbox-tools.ts";
import { isRemoteSessionMessage, sessionMessageRouteError } from "./session-message-route.ts";

export function result<TDetails extends Record<string, unknown>>(
	text: string,
	details: TDetails,
): AgentToolResult<TDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

export function sendAgentMessage(
	store: MultiAgentStore,
	params: SendAgentMessageParams,
	ctx?: ExtensionContext,
	onSessionMessageSent?: MultiAgentExtensionOptions["onSessionMessageSent"],
): AgentToolResult<SendAgentMessageToolDetails> {
	const target = formatSentMessageTarget(params, params.toSessionId);
	const senderId = currentMessageSenderId(store, ctx);
	const routeError = senderId ? sessionMessageRouteError(ctx?.controlDbPath, params) : undefined;
	if (routeError)
		return {
			...result(`Could not send agent message to ${target}: ${routeError}`, {
				agent: currentMessageSenderAgent(store, ctx),
				message: failedMessage(senderId ?? "unknown_subagent", params.toAgentId, "message", params.message),
			}),
			isError: true,
		};
	if (isRemoteSessionMessage(params)) return sendMainRuntimeSessionMessage(store, params, ctx, onSessionMessageSent);
	if (params.toSessionId) {
		if (isMainRuntimeTarget(params.toAgentId)) {
			return sendMainRuntimeSessionMessage(store, params, ctx, onSessionMessageSent);
		}
		const targetSessionId = resolveAgentRuntimeSessionId(store, params.toAgentId);
		if (targetSessionId !== undefined && targetSessionId !== params.toSessionId) {
			return result(
				`Could not send agent message to ${params.toAgentId}: target session does not match ${params.toSessionId}.`,
				{
					agent: currentMessageSenderAgent(store, ctx),
					message: failedMessage(senderId ?? "unknown_subagent", params.toAgentId, "message", params.message),
				},
			);
		}
	}

	if (!senderId) {
		return result(`Could not send agent message to ${target}: subagent runtime identity is unavailable.`, {
			agent: emptyAgent("unknown_subagent"),
			message: failedMessage("unknown_subagent", params.toAgentId, "message", params.message),
		});
	}
	const sender = store.getAgent(senderId);
	const recipient = store.getAgent(params.toAgentId);
	if (
		recipient &&
		(recipient.parentId ?? MAIN_THREAD_AGENT_ID) === senderId &&
		!isActiveLifecycle(recipient.lifecycle)
	) {
		return {
			...result(`Could not send agent message to ${target}: agent is closed; use attach_session_agent.`, {
				agent: sender ?? emptyAgent(senderId),
				message: failedMessage(senderId, params.toAgentId, "message", params.message),
			}),
			isError: true,
		};
	}
	const messageInput = {
		fileRefs: params.fileRefs,
		body: params.message,
		threadId: params.threadId,
		toAgentId: params.toAgentId,
	};
	const sent = sender
		? store.sendMailboxMessage(sender.id, sender.revision, messageInput)
		: store.sendMainThreadMailboxMessage(messageInput);
	if (!sent.ok) {
		return result(`Could not send agent message from ${senderId} to ${target}: ${sent.error}`, {
			agent: "current" in sent ? sent.current : emptyAgent(senderId),
			message: failedMessage(senderId, params.toAgentId, "message", params.message),
		});
	}

	if (params.toSessionId) {
		const recipientAgentId = isMainRuntimeTarget(params.toAgentId) ? null : params.toAgentId;
		if (
			!mirrorRuntimeSessionMessage(store, sent.message, ctx, {
				sessionId: params.toSessionId,
				agentId: recipientAgentId,
				host: params.toHost,
			})
		) {
			const failedMessage = markFailedMailboxTransportMessage(store, sent.message);
			const error = `Could not send runtime session message to ${target}: runtime mailbox transport is unavailable.`;
			return result(error, { agent: sent.agent, message: failedMessage });
		}
		onSessionMessageSent?.({ message: sent.message, toSessionId: params.toSessionId });
	} else if (!mirrorRuntimeMailboxMessage(store, sent.message, ctx)) {
		const failedMessage = markFailedMailboxTransportMessage(store, sent.message);
		const error = `Could not send agent message to ${target}: runtime mailbox transport is unavailable.`;
		return result(error, { agent: sent.agent, message: failedMessage });
	}

	return result(`Sent message to ${formatSentMessageTarget(sent.message, params.toSessionId)}.`, {
		agent: sent.agent,
		message: sent.message,
	});
}

export function sendMainRuntimeSessionMessage(
	store: MultiAgentStore,
	params: SendAgentMessageParams,
	ctx: ExtensionContext | undefined,
	onSessionMessageSent?: MultiAgentExtensionOptions["onSessionMessageSent"],
): AgentToolResult<SendAgentMessageToolDetails> {
	const target = formatSentMessageTarget(params, params.toSessionId);
	const sender = currentMessageSenderAgent(store, ctx);
	const senderId = currentMessageSenderId(store, ctx);
	if (!params.toSessionId) {
		return result(`Could not send runtime session message to ${target}: target session unavailable.`, {
			agent: sender,
			message: failedMessage(senderId ?? "unknown_subagent", params.toAgentId, "message", params.message),
		});
	}
	if (!senderId) {
		const error = `Could not send runtime session message to ${target}: subagent runtime identity is unavailable.`;
		return result(error, {
			agent: sender,
			message: failedMessage("unknown_subagent", params.toAgentId, "message", params.message),
		});
	}
	const message = store.recordOutboundSessionMessage({
		fileRefs: params.fileRefs,
		body: params.message,
		fromAgentId: senderId,
		threadId: params.threadId,
		toAgentId: params.toAgentId,
	});
	if (
		!mirrorRuntimeSessionMessage(store, message, ctx, {
			sessionId: params.toSessionId,
			agentId: isMainRuntimeTarget(params.toAgentId) ? null : params.toAgentId,
			host: params.toHost,
		})
	) {
		const failedMessage = markFailedMailboxTransportMessage(store, message);
		const error = `Could not send runtime session message to ${target}: runtime mailbox transport is unavailable.`;
		return result(error, { agent: sender, message: failedMessage });
	}
	const remote = isRemoteSessionMessage(params);
	if (!remote) onSessionMessageSent?.({ message, toSessionId: params.toSessionId });
	return result(
		remote
			? `Queued message to session ${params.toSessionId} for relay to host ${params.toHost}.`
			: `Sent message to session ${params.toSessionId}.`,
		{
			agent: sender,
			message,
		},
	);
}

export function markFailedMailboxTransportMessage(
	store: MultiAgentStore,
	message: AgentMailboxMessage,
): AgentMailboxMessage {
	const error = "Runtime mailbox transport is unavailable.";
	try {
		return store.markMailboxMessageFailed(message.id, error) ?? { ...message, error, status: "failed" as const };
	} catch (cause) {
		console.error(`Failed to persist failed mailbox message ${message.id}:`, cause);
		return { ...message, error, status: "failed" as const };
	}
}

export function mirrorRuntimeSessionMessage(
	store: MultiAgentStore,
	message: AgentMailboxMessage,
	ctx: ExtensionContext | undefined,
	route: RuntimeMailboxAddress & { host?: string },
): boolean {
	if (!ctx?.controlDbPath) {
		return false;
	}
	const storeRef = buildRuntimeMailboxStoreRef(store, message, ctx);
	if (!storeRef) {
		console.error(
			`Runtime mailbox requires a store persisted to the control DB; dropped session message ${message.id}.`,
		);
		return false;
	}
	try {
		enqueueRuntimeMailboxMessage(ctx.controlDbPath, {
			kind: message.kind,
			recipientHost: route.host,
			recipient: { agentId: route.agentId, sessionId: route.sessionId },
			sender: {
				agentId: message.fromAgentId === MAIN_THREAD_AGENT_ID ? null : message.fromAgentId,
				sessionId: ctx.sessionManager.getSessionId(),
			},
			storeRef,
		});
		return true;
	} catch (error) {
		console.error(`Failed to enqueue runtime session message ${message.id}:`, error);
		return false;
	}
}

export function currentMessageSenderId(_store: MultiAgentStore, ctx: ExtensionContext | undefined): string | undefined {
	if (ctx?.multiAgentAgentId) {
		return ctx.multiAgentAgentId;
	}
	if (ctx?.multiAgentRequiresAgentId) {
		return undefined;
	}
	return MAIN_THREAD_AGENT_ID;
}

export function currentMessageSenderAgent(store: MultiAgentStore, ctx: ExtensionContext | undefined): AgentSnapshot {
	const senderId = currentMessageSenderId(store, ctx) ?? "unknown_subagent";
	return store.getAgent(senderId) ?? emptyAgent(senderId);
}

export function resolveAgentRuntimeSessionId(store: MultiAgentStore, toAgentId: string): string | null | undefined {
	const target = store.getAgent(toAgentId);
	return target ? (target.transcript?.sessionId ?? null) : undefined;
}

export function isMainRuntimeTarget(toAgentId: string): boolean {
	return toAgentId === MAIN_THREAD_AGENT_ID || toAgentId === "supervisor";
}

export function formatSentMessageTarget(
	message: Pick<AgentMailboxMessage, "toAgentId">,
	toSessionId: string | undefined,
): string {
	return toSessionId ? `${message.toAgentId} in session ${toSessionId}` : message.toAgentId;
}

// Transport rows never copy message bodies: they reference the persisted store row that
// owns the content. Messaging therefore requires a store persisted to the runtime's
// control DB; there is no in-memory delivery path.
export function buildRuntimeMailboxStoreRef(
	store: MultiAgentStore,
	message: AgentMailboxMessage,
	ctx: ExtensionContext | undefined,
): { sessionPath: string; messageId: string } | undefined {
	const persistence = store.getPersistenceTarget();
	if (!persistence || !message.id || persistence.controlDbPath !== ctx?.controlDbPath) {
		return undefined;
	}
	return { messageId: message.id, sessionPath: persistence.sessionPath };
}

export function mirrorRuntimeMailboxMessage(
	store: MultiAgentStore,
	message: AgentMailboxMessage,
	ctx: ExtensionContext | undefined,
): boolean {
	if (!ctx?.controlDbPath) return false;
	const recipient = resolveRuntimeRecipient(store, message, ctx);
	if (!recipient) return false;
	const storeRef = buildRuntimeMailboxStoreRef(store, message, ctx);
	if (!storeRef) {
		console.error(
			`Runtime mailbox requires a store persisted to the control DB; dropped mailbox message ${message.id}.`,
		);
		return false;
	}
	try {
		enqueueRuntimeMailboxMessage(ctx.controlDbPath, {
			kind: message.kind,
			recipient,
			sender: {
				agentId: message.fromAgentId,
				sessionId: ctx.sessionManager.getSessionId(),
			},
			storeRef,
		});
		return true;
	} catch (error) {
		console.error(`Failed to enqueue runtime mailbox message ${message.id}:`, error);
		return false;
	}
}

export function resolveRuntimeRecipient(
	store: MultiAgentStore,
	message: AgentMailboxMessage,
	ctx: ExtensionContext,
): RuntimeMailboxAddress | undefined {
	const target = store.getAgent(message.toAgentId);
	if (target?.transcript?.sessionId) {
		return { agentId: target.id, sessionId: target.transcript.sessionId };
	}
	if (message.toAgentId !== MAIN_THREAD_AGENT_ID && message.toAgentId !== "supervisor") {
		return { agentId: message.toAgentId, sessionId: ctx.sessionManager.getSessionId() };
	}
	const currentSessionId = ctx.sessionManager.getSessionId();
	return { agentId: null, sessionId: ctx.multiAgentParentSessionId ?? currentSessionId };
}

export function emptyAgent(agentId: string): AgentSnapshot {
	const timestamp = new Date(0).toISOString();
	return {
		agentType: "unknown",
		createdAt: timestamp,
		cwd: "",
		displayName: agentId,
		id: agentId,
		lifecycle: "failed" satisfies AgentLifecycleState,
		parentId: undefined,
		permission: { narrowed: true, policy: "on-request" },
		revision: 0,
		updatedAt: timestamp,
	};
}

export function failedMessage(
	fromAgentId: string,
	toAgentId: string,
	kind: AgentMailboxMessage["kind"],
	body: string,
): AgentMailboxMessage {
	const timestamp = new Date(0).toISOString();
	return {
		body,
		createdAt: timestamp,
		fromAgentId,
		id: "",
		kind,
		status: "failed",
		toAgentId,
		updatedAt: timestamp,
	};
}
