import { hostname } from "node:os";
import {
	cancelSupervisorRequest,
	deliverRuntimeMailboxMessage,
	enqueueStoredRuntimeMailboxMessage,
	postSupervisorRequest,
	type RuntimeMailboxMessage,
	type RuntimeMailboxMessageKind,
	readRuntimeMailboxMessageForDelivery,
	type SupervisorReplyRoute,
	type SupervisorRequestKind,
	type SupervisorResponse,
	takeRuntimeMailboxMessagesForDelivery,
} from "../core/session-control-db.ts";
import { notifySupervisorRequest } from "./request-wake.ts";

/**
 * Supervisor mail: requests from other hosts reach the Supervisor session's mailbox through the relay,
 * and every response reaches the asking runtime's mailbox, through the relay for another host.
 */

const REPLY_PREFIX = "supervisor_response:";
const REQUEST_PREFIX = "supervisor_request:";
const CANCEL_PREFIX = "supervisor_cancel:";
const INSPECT_PREFIX = "supervisor_inspect:";
const INSPECT_NAMES_PREFIX = "supervisor_inspect_names:";
const INSPECT_NAMES_REPLY_PREFIX = "supervisor_inspect_names_reply:";
const CORRECTION_PREFIX = "supervisor_correction:";
const NOT_RUNNING_SUFFIX = "-not-running";
export const STORE_PATH = "supervisor-mail";
const MAIL_CHECK_INTERVAL_MS = 1_000;

/** A session description answering an `inspect_session` call; not a Supervisor decision. */
export interface SessionInspection {
	kind: "inspection";
	text: string;
	sessionNames?: Record<string, string>;
}

export interface SupervisorReply {
	type: "supervisor_response";
	requestId: string;
	requestKind: SupervisorRequestKind;
	response: SupervisorResponse | SessionInspection;
	/** Set when the user answered an escalated question in the Supervisor session. */
	answeredBy?: "user";
	/** Set on the relay's notice that the Supervisor session is not running; the request stays queued for it. */
	notRunning?: true;
	senderHost?: string;
}

export interface SupervisorRequestEnvelope {
	type: "supervisor_request";
	kind: SupervisorRequestKind;
	payload: Record<string, unknown>;
	projectId: string;
	deadlineAt: string;
	replyTo: SupervisorReplyRoute;
}

interface SupervisorCancelEnvelope {
	type: "supervisor_cancel";
	replyTo: SupervisorReplyRoute;
	reason: string;
	/** The answers the user gave in the asker's own panel, stored with the question. */
	localAnswers?: Record<string, string>;
}

/** Where the Supervisor session runs; `host` is set only when it is another machine. */
export interface SupervisorAddress {
	sessionId: string;
	host?: string;
}

export function isRemoteHost(host: string | undefined): host is string {
	return host !== undefined && host !== hostname();
}

function routeKey(route: SupervisorReplyRoute): string {
	return `${route.sessionId}:${route.agentId ?? "main"}:${route.requestId}`;
}

function enqueueMail(
	controlDbPath: string,
	input: {
		kind: RuntimeMailboxMessageKind;
		messageId: string;
		body: unknown;
		from: { sessionId: string; agentId: string | null };
		to: { sessionId: string; agentId: string | null; host?: string };
	},
): void {
	enqueueStoredRuntimeMailboxMessage(controlDbPath, {
		kind: input.kind,
		message: {
			body: JSON.stringify(input.body),
			id: input.messageId,
			kind: input.kind,
			status: "pending",
			fromAgentId: input.from.agentId ?? "main",
			toAgentId: input.to.agentId ?? "main",
		},
		recipient: { sessionId: input.to.sessionId, agentId: input.to.agentId },
		...(input.to.host ? { recipientHost: input.to.host } : {}),
		sender: input.from,
		storeRef: { messageId: input.messageId, sessionPath: STORE_PATH },
	});
}

/** Sends one response to the runtime that asked; a question may get an escalation and then an answer. */
export function sendSupervisorReply(
	controlDbPath: string,
	supervisorSessionId: string,
	route: SupervisorReplyRoute,
	reply: Omit<SupervisorReply, "type" | "requestId">,
): void {
	const body: SupervisorReply = { type: "supervisor_response", requestId: route.requestId, ...reply };
	const sessionNamesOnly = reply.response.kind === "inspection" && reply.response.sessionNames !== undefined;
	enqueueMail(controlDbPath, {
		kind: sessionNamesOnly ? "system" : "reply",
		messageId: `${sessionNamesOnly ? INSPECT_NAMES_REPLY_PREFIX : REPLY_PREFIX}${routeKey(route)}:${reply.response.kind}`,
		body,
		from: { sessionId: supervisorSessionId, agentId: null },
		to: route,
	});
}

/**
 * Sends the user's revised answers to the session that asked. It is a new inbox message, not a reply:
 * the original question already has its answer, and the asking turn may be long over.
 */
export function sendQuestionCorrection(
	controlDbPath: string,
	supervisorSessionId: string,
	route: SupervisorReplyRoute,
	answers: Record<string, string>,
	revisedAt: string,
	late = false,
): void {
	const lines = Object.entries(answers).map(([question, answer]) => `- ${question} → ${answer}`);
	const header = late
		? `User answered after the question ended without an answer (request ${route.requestId}):`
		: `User revised answers (request ${route.requestId}):`;
	const messageId = `${CORRECTION_PREFIX}${routeKey(route)}:${revisedAt}`;
	enqueueStoredRuntimeMailboxMessage(controlDbPath, {
		kind: "message",
		message: {
			body: [header, ...lines].join("\n"),
			id: messageId,
			kind: "message",
			status: "pending",
			fromAgentId: "main",
			toAgentId: route.agentId ?? "main",
		},
		recipient: { sessionId: route.sessionId, agentId: route.agentId },
		...(route.host ? { recipientHost: route.host } : {}),
		sender: { sessionId: supervisorSessionId, agentId: null },
		storeRef: { messageId, sessionPath: STORE_PATH },
	});
}

/** Queues a request for the Supervisor session on another host. */
export function sendRemoteSupervisorRequest(
	controlDbPath: string,
	supervisor: SupervisorAddress,
	request: Omit<SupervisorRequestEnvelope, "type">,
): void {
	const body: SupervisorRequestEnvelope = { type: "supervisor_request", ...request };
	enqueueMail(controlDbPath, {
		kind: "message",
		messageId: `${REQUEST_PREFIX}${routeKey(request.replyTo)}`,
		body,
		from: { sessionId: request.replyTo.sessionId, agentId: request.replyTo.agentId },
		to: { sessionId: supervisor.sessionId, agentId: null, host: supervisor.host },
	});
}

export function sendRemoteSupervisorCancel(
	controlDbPath: string,
	supervisor: SupervisorAddress,
	route: SupervisorReplyRoute,
	reason: string,
	localAnswers?: Record<string, string>,
): void {
	const body: SupervisorCancelEnvelope = {
		type: "supervisor_cancel",
		replyTo: route,
		reason,
		...(localAnswers ? { localAnswers } : {}),
	};
	enqueueMail(controlDbPath, {
		kind: "message",
		messageId: `${CANCEL_PREFIX}${routeKey(route)}`,
		body,
		from: { sessionId: route.sessionId, agentId: route.agentId },
		to: { sessionId: supervisor.sessionId, agentId: null, host: supervisor.host },
	});
}

/** Queues a request for the Supervisor: in the local queue, or through the relay for another host. */
export function submitSupervisorRequest(
	controlDbPath: string,
	supervisor: SupervisorAddress,
	request: Omit<SupervisorRequestEnvelope, "type">,
): void {
	if (isRemoteHost(supervisor.host)) {
		sendRemoteSupervisorRequest(controlDbPath, supervisor, request);
		return;
	}
	postSupervisorRequest(controlDbPath, {
		deadlineAt: request.deadlineAt,
		kind: request.kind,
		payload: request.payload,
		projectId: request.projectId,
		replyTo: request.replyTo,
		senderSessionId: request.replyTo.sessionId,
	});
	notifySupervisorRequest(controlDbPath);
}

/** Cancels a submitted request that is still pending, being evaluated, or escalated. */
export function cancelSubmittedSupervisorRequest(
	controlDbPath: string,
	supervisor: SupervisorAddress,
	route: SupervisorReplyRoute,
	reason: string,
	localAnswers?: Record<string, string>,
): void {
	if (isRemoteHost(supervisor.host)) {
		sendRemoteSupervisorCancel(controlDbPath, supervisor, route, reason, localAnswers);
		return;
	}
	if (cancelSupervisorRequest(controlDbPath, route, reason, localAnswers)) notifySupervisorRequest(controlDbPath);
}

/** Asks the relay on `target.host` to describe a session there; the answer arrives as a reply to `route`. */
export function sendSessionInspectionRequest(
	controlDbPath: string,
	target: { sessionId: string; host: string },
	route: SupervisorReplyRoute,
): void {
	enqueueMail(controlDbPath, {
		kind: "message",
		messageId: `${INSPECT_PREFIX}${routeKey(route)}`,
		body: { type: "supervisor_inspect", replyTo: route },
		from: { sessionId: route.sessionId, agentId: route.agentId },
		to: { sessionId: target.sessionId, agentId: null, host: target.host },
	});
}

/** Asks a remote relay for names of only the sessions already present in a question list. */
export function sendSessionNamesRequest(
	controlDbPath: string,
	target: { host: string },
	sessionIds: string[],
	route: SupervisorReplyRoute,
): void {
	if (sessionIds.length === 0) return;
	enqueueMail(controlDbPath, {
		kind: "system",
		messageId: `${INSPECT_NAMES_PREFIX}${routeKey(route)}`,
		body: { type: "supervisor_inspect_names", replyTo: route, sessionIds },
		from: { sessionId: route.sessionId, agentId: route.agentId },
		to: { sessionId: `name-lookup-${route.requestId}`, agentId: null, host: target.host },
	});
}

export function isSessionInspectionRequest(messageId: string): boolean {
	return messageId.startsWith(INSPECT_PREFIX) || messageId.startsWith(INSPECT_NAMES_PREFIX);
}

/** Answers a relayed inspection request on the host that owns the session, without waking that session. */
export function answerSessionInspectionRequest(
	controlDbPath: string,
	peer: string,
	data: Record<string, unknown>,
	describe: (sessionId: string) => string,
	lookupNames: (sessionIds: string[]) => Record<string, string>,
): void {
	const body = JSON.parse(String(data.body)) as {
		type?: string;
		replyTo: SupervisorReplyRoute;
		sessionIds?: unknown;
	};
	const sessionNamesOnly = body.type === "supervisor_inspect_names";
	const sessionId = sessionNamesOnly ? "pi-session-name-lookup" : String(data.recipientSessionId);
	const sessionIds = sessionNamesOnly
		? Array.isArray(body.sessionIds) && body.sessionIds.every((id): id is string => typeof id === "string")
			? body.sessionIds
			: []
		: [];
	sendSupervisorReply(
		controlDbPath,
		sessionId,
		{ ...body.replyTo, host: peer },
		{
			requestKind: "supervisor_advisory",
			response: sessionNamesOnly
				? { kind: "inspection", text: "", sessionNames: lookupNames(sessionIds) }
				: { kind: "inspection", text: describe(String(data.recipientSessionId)) },
		},
	);
}

function parseBody(message: RuntimeMailboxMessage): Record<string, unknown> {
	const parsed: unknown = JSON.parse(message.body);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Malformed Supervisor mail ${message.storeRef.messageId}`);
	}
	return parsed as Record<string, unknown>;
}

/**
 * Queues a request or cancellation that arrived from another host in the Supervisor session's mailbox.
 * Returns false for any other message.
 */
export function ingestSupervisorRequestMail(controlDbPath: string, message: RuntimeMailboxMessage): boolean {
	const messageId = message.storeRef.messageId;
	if (messageId.startsWith(CANCEL_PREFIX)) {
		const cancel = parseBody(message) as unknown as SupervisorCancelEnvelope;
		if (cancelSupervisorRequest(controlDbPath, cancel.replyTo, cancel.reason, cancel.localAnswers)) {
			notifySupervisorRequest(controlDbPath);
		}
		return true;
	}
	if (!messageId.startsWith(REQUEST_PREFIX)) return false;
	const request = parseBody(message) as unknown as SupervisorRequestEnvelope;
	// The relay records the asking host; the reply goes back through it.
	const replyTo = { ...request.replyTo, host: message.senderHost };
	postSupervisorRequest(controlDbPath, {
		deadlineAt: request.deadlineAt,
		kind: request.kind,
		payload: request.payload,
		projectId: request.projectId,
		replyTo,
		senderSessionId: replyTo.sessionId,
	});
	notifySupervisorRequest(controlDbPath);
	return true;
}

interface ReplyWaiter {
	controlDbPath: string;
	route: SupervisorReplyRoute;
	onReply: (reply: SupervisorReply) => void;
}

/** Runtimes of this process waiting for Supervisor replies, by route key. */
const waiters = new Map<string, ReplyWaiter>();

/** Route keys of questions the user answered locally in this process. */
const locallyAnsweredQuestions = new Set<string>();

/** Records that the user answered a question locally, so a late escalation for it is stale. */
export function markSupervisorQuestionAnsweredLocally(route: SupervisorReplyRoute): void {
	locallyAnsweredQuestions.add(routeKey(route));
}

/** The waited-for route key of a reply or of a relay "not running" notice for a request. */
function readMailKey(message: RuntimeMailboxMessage): string | undefined {
	const messageId = message.storeRef.messageId;
	if (messageId.startsWith(INSPECT_NAMES_REPLY_PREFIX)) {
		return messageId.slice(INSPECT_NAMES_REPLY_PREFIX.length).replace(/:[a-z]+$/, "");
	}
	if (messageId.startsWith(REPLY_PREFIX)) return messageId.slice(REPLY_PREFIX.length).replace(/:[a-z]+$/, "");
	if (messageId.startsWith(REQUEST_PREFIX) && messageId.endsWith(NOT_RUNNING_SUFFIX)) {
		return messageId.slice(REQUEST_PREFIX.length, -NOT_RUNNING_SUFFIX.length);
	}
	return undefined;
}

function readReply(message: RuntimeMailboxMessage, waiter: ReplyWaiter): SupervisorReply {
	if (
		message.storeRef.messageId.startsWith(REPLY_PREFIX) ||
		message.storeRef.messageId.startsWith(INSPECT_NAMES_REPLY_PREFIX)
	) {
		const reply = parseBody(message) as unknown as SupervisorReply;
		return message.storeRef.messageId.startsWith(INSPECT_NAMES_REPLY_PREFIX)
			? { ...reply, senderHost: message.senderHost }
			: reply;
	}
	return {
		type: "supervisor_response",
		requestId: waiter.route.requestId,
		requestKind: "supervisor_advisory",
		response: { kind: "error", reason: `The Supervisor session is not running: ${message.body}` },
		notRunning: true,
	};
}

/**
 * Hands a claimed mailbox message to its waiting caller. Returns true when the message was Supervisor
 * mail for this process: delivered to a waiter, or a stale reply dropped. A question reply with no
 * waiter (its panel was lost to a restart) returns false so it reaches the model as an inbox message,
 * except an escalation of a question the user already answered locally.
 */
export function deliverSupervisorMail(message: RuntimeMailboxMessage): boolean {
	const key = readMailKey(message);
	if (!key) return false;
	const waiter = waiters.get(key);
	if (waiter) {
		waiter.onReply(readReply(message, waiter));
		return true;
	}
	if (message.storeRef.messageId.startsWith(INSPECT_NAMES_REPLY_PREFIX)) return true;
	if (!message.storeRef.messageId.startsWith(REPLY_PREFIX)) return true;
	const reply = parseBody(message) as unknown as SupervisorReply;
	if (reply.requestKind !== "question") return true;
	return reply.response.kind === "escalate" && locallyAnsweredQuestions.has(key);
}

/**
 * Calls `onReply` for each Supervisor reply to `route` until the returned stop function runs. Replies
 * are taken when the mailbox signal arrives, because a runtime does not drain its mailbox mid-turn.
 */
export function watchSupervisorReplies(
	controlDbPath: string,
	route: SupervisorReplyRoute,
	onReply: (reply: SupervisorReply) => void,
): () => void {
	const key = routeKey(route);
	waiters.set(key, { controlDbPath, route, onReply });
	updateSignalListener();
	takeWaitedReplies();
	return () => {
		if (waiters.get(key)?.onReply !== onReply) return;
		waiters.delete(key);
		updateSignalListener();
	};
}

function takeWaitedReplies(): void {
	for (const waiter of [...waiters.values()]) {
		const recipient = { sessionId: waiter.route.sessionId, agentId: waiter.route.agentId };
		const isWaitedFor = (message: RuntimeMailboxMessage) => {
			const key = readMailKey(message);
			return key !== undefined && waiters.has(key);
		};
		for (const message of takeRuntimeMailboxMessagesForDelivery(waiter.controlDbPath, recipient, isWaitedFor)) {
			// The reply's content reaches the transcript through the waiting caller's result.
			const snapshot = readRuntimeMailboxMessageForDelivery(waiter.controlDbPath, message.id);
			if (snapshot?.payloadValid)
				deliverRuntimeMailboxMessage(waiter.controlDbPath, message.id, snapshot.payloadData);
			deliverSupervisorMail(message);
		}
	}
}

const onMailboxSignal = () => {
	try {
		takeWaitedReplies();
	} catch (error) {
		console.error("Failed to take Supervisor replies:", error);
	}
};

let mailboxCheckTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Waiters wake on the mailbox signal and also check the local mailbox every second while waiting:
 * a sender signals only a process whose command line it can verify as Pi, and a signal can be missed.
 */
function updateSignalListener(): void {
	const listening = process.listeners("SIGUSR2").includes(onMailboxSignal);
	if (waiters.size > 0 && !listening && process.platform !== "win32") process.on("SIGUSR2", onMailboxSignal);
	if (waiters.size > 0 && !mailboxCheckTimer) {
		mailboxCheckTimer = setInterval(onMailboxSignal, MAIL_CHECK_INTERVAL_MS);
		mailboxCheckTimer.unref();
	}
	if (waiters.size > 0) return;
	if (listening) process.off("SIGUSR2", onMailboxSignal);
	clearInterval(mailboxCheckTimer);
	mailboxCheckTimer = undefined;
}
