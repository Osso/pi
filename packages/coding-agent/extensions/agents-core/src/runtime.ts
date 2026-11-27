export type { MultiAgentRuntimeHandles, WaitNotificationsWake } from "./contracts.ts";

export {
	createProductionAttachedSessionFactory,
	createProductionChildAgentSessionFactory,
} from "./session-factories.ts";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getAssistantContentText } from "../../../src/core/assistant-narration.ts";
import type { AttachSessionDispatchInput } from "./attachment.ts";
import { attachSessionAgent, dispatchAttachedSessionAgent } from "./attachment.ts";
import {
	abortAgentHandleSafely,
	CLOSE_ALL_AGENTS_EVENT,
	type CloseAllAgentsRequest,
	cancelAgent,
	closeAllAgents,
	steerAgent,
} from "./control.ts";
import type { BackgroundDispatchContext } from "./dispatch.ts";
import { backgroundCommand, formatAgentStatus, isChildAgentRuntime, spawnAgent } from "./dispatch.ts";
import type { WaitingDesktopNotificationHandles } from "./dispatch-pipeline.ts";
import { closeWaitingDesktopNotification, publishCoordinatorSnapshot } from "./dispatch-pipeline.ts";
import {
	consumeNotifications,
	createMultiAgentRuntimeHandles,
	mirrorLifecycleRuntimeMailboxMessage,
	mirrorPendingLifecycleRuntimeMailboxMessages,
	waitAgents,
	waitNotifications,
} from "./wait.ts";

export type {
	AgentSteeringRequest,
	AgentSteeringRequestResult,
	AgentSteeringRuntimeBinding,
	CancelReservedAgentResult,
} from "./control.ts";
export {
	cancelOwnedAgentRuntime,
	requestAgentSteering,
	requestInteractiveAgentSteering,
	resolveSelectedSessionMutationTarget,
	wakeWaitAgentsAfterSteering,
} from "./control.ts";
export { deliverTerminalOutboxForStore } from "./dispatch-pipeline.ts";
export {
	consumeNotifications,
	createMultiAgentRuntimeHandles,
	waitNotifications,
} from "./wait.ts";

import { sendDesktopNotification } from "../../../src/core/desktop-notification.ts";
import {
	type AgentToolResult,
	defineTool,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "../../../src/core/extensions/types.ts";
import { type AgentSnapshot, isActiveLifecycle, MultiAgentStore } from "../../../src/core/multi-agent-store.ts";
import { isProcessIdentityAlive, isSupersededRuntimeIdentity } from "../../../src/core/runtime-process.ts";
import { readMultiAgentRuntimeOwnership } from "../../../src/core/session-control-db.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import { registerAgentViewerTools } from "../../agent-viewer/src/runtime.ts";
import { registerSetAgentModelTool } from "./agent-model-tool.ts";
import type { MultiAgentRuntimeHandles } from "./contracts.ts";
import { createLifecycleCoordinator, RUNTIME_PROCESS_IDENTITY } from "./lifecycle-runtime.ts";
import {
	type ContactParentMessageParams,
	registerModelMailboxTools,
	type SendAgentMessageParams,
} from "./mailbox-tools.ts";
import {
	emptyAgent,
	failedMessage,
	markFailedMailboxTransportMessage,
	mirrorRuntimeMailboxMessage,
	result,
	sendAgentMessage,
} from "./messaging.ts";
import { registerQuestionRelayTools } from "./question-relay-tools.ts";
import { createRemoteAttachedSessionFactory } from "./remote-child-session.ts";

export type {
	AgentDesktopNotification,
	AgentDesktopNotifier,
	AttachedSessionDispatchInput,
	AttachedSessionFactory,
	ChildAgentDispatchInput,
	ChildAgentSession,
	ChildAgentSessionFactory,
	MultiAgentExtensionOptions,
	MultiAgentPiRequestHandler,
	ProductionChildAgentSessionFactoryOptions,
} from "./contracts.ts";

import {
	type AgentListToolDetails,
	type AgentSelectionDetails,
	type AttachSessionAgentParams,
	attachSessionAgentSchema,
	CHILD_ORCHESTRATION_UNAVAILABLE_MESSAGE,
	type ContactParentToolDetails,
	CRASH_RECOVERY_PROMPT,
	cancelAgentSchema,
	type LastMessageDetails,
	type ListAgentsParams,
	listAgentsSchema,
	MAIN_THREAD_AGENT_ID,
	type MainThreadSnapshot,
	MESSAGE_CONTENT_LIMIT,
	type MultiAgentExtensionOptions,
	type MultiAgentPiRequestHandler,
	spawnAgentSchema,
	steerAgentSchema,
	waitAgentsSchema,
} from "./contracts.ts";

function jobsCommand(store: MultiAgentStore, ctx: ExtensionCommandContext): void {
	const agents = store.listAgents().filter((agent) => agent.agentType === "background");
	if (agents.length === 0) {
		ctx.ui.notify("No background jobs.", "info");
		return;
	}

	ctx.ui.notify(agents.map((agent) => `${agent.id} ${formatAgentStatus(agent)}`).join("\n"), "info");
}

type AssistantContent = AssistantMessage["content"][number];

export function createMultiAgentPiRequestHandler(options: MultiAgentExtensionOptions): MultiAgentPiRequestHandler {
	const store = resolveMultiAgentStore(options);
	const runtimeHandles = options.runtimeHandles ?? createMultiAgentRuntimeHandles();
	const activeDispatches = runtimeHandles.dispatches;
	const ownerships = runtimeHandles.ownerships;
	const backgroundSessions = runtimeHandles.sessions;
	const desktopNotifier = options.desktopNotifier ?? sendDesktopNotification;
	const waitingDesktopNotifications: WaitingDesktopNotificationHandles = new Map();
	const runtimeLifecycleMirror = createRuntimeLifecycleMirror(store);
	let disposed = false;

	const handler: MultiAgentPiRequestHandler = async (request, ctx, signal, activeToolCallId) => {
		if (disposed) throw new Error("Multi-agent Pi request handler is disposed");
		if (!isChildAgentRuntime(ctx)) runtimeLifecycleMirror.bind(ctx);
		if (isChildAgentRuntime(ctx) && isSupervisorOnlyAgentRequest(request.method)) {
			throw new Error(CHILD_ORCHESTRATION_UNAVAILABLE_MESSAGE);
		}
		if (request.method === "agents.spawn") {
			const result = await spawnAgent(
				store,
				options.createChildSession,
				activeDispatches,
				ownerships,
				request.params,
				ctx,
				desktopNotifier,
				waitingDesktopNotifications,
				backgroundSessions,
				activeToolCallId,
			);
			return result.details;
		}

		if (request.method === "agents.wait") {
			assertNoWaitAgentsParams(request.params, "pi.agents.wait");
			const wake = await waitNotifications(store, runtimeHandles, signal, ctx);
			// The bridge returns only a wake, not accepted session input. Leave coordination for the session checkpoint.
			if (wake.kind !== "coordination") consumeNotifications(store, wake, ctx);
			return null;
		}

		if (request.method === "agents.attachSession") {
			const result = await attachSessionAgent({
				createAttachedSession: options.createAttachedSession,
				ctx,
				desktopNotifier,
				dispatches: activeDispatches,
				handles: backgroundSessions,
				params: request.params as AttachSessionAgentParams,
				ownerships,
				store,
				waitingDesktopNotifications,
			});
			return result.details;
		}

		if (request.method === "agents.list") {
			const params =
				request.params === undefined || request.params === null ? {} : (request.params as ListAgentsParams);
			const result = listAgents(store, params);
			return result.details;
		}

		if (request.method === "agents.current") {
			return selectCurrentAgent(store);
		}

		if (request.method === "agents.select") {
			return selectAgent(store, request.params, options.isAgentViewUserOwned?.() === true);
		}

		if (request.method === "messages.last") {
			return findLastSessionMessage(ctx.sessionManager.getBranch());
		}

		if (request.method === "messages.send") {
			const result = sendAgentMessage(store, request.params as SendAgentMessageParams, ctx);
			return result.details;
		}

		return undefined;
	};
	handler.dispose = () => {
		disposed = true;
		runtimeLifecycleMirror.dispose();
	};
	return handler;
}

function selectCurrentAgent(store: MultiAgentStore): AgentSelectionDetails {
	const selectedAgentId = store.getSelectedAgentId();
	const selectedAgent = selectedAgentId ? store.getAgent(selectedAgentId) : undefined;
	if (!selectedAgent || !isActiveLifecycle(selectedAgent.lifecycle)) {
		return { agent: createMainThreadSnapshot() };
	}
	return { agent: selectedAgent };
}

function selectAgent(store: MultiAgentStore, params: unknown, viewUserOwned: boolean): AgentSelectionDetails {
	const agentId = normalizeSelectAgentId(params);
	if (viewUserOwned) {
		throw new Error("pi.agents.select is unavailable in interactive mode; only the user can switch the agent view");
	}

	if (agentId === MAIN_THREAD_AGENT_ID) {
		store.clearSelectedAgentView();
		return { agent: createMainThreadSnapshot() };
	}

	const result = store.selectAgentViewWithStatus(agentId);
	if (result.ok) return { agent: result.agent };
	throw new Error(`Agent not found: ${agentId}`);
}

function normalizeSelectAgentId(params: unknown): string {
	if (typeof params === "string") {
		return params;
	}
	if (!params || typeof params !== "object") {
		throw new Error("pi.agents.select requires an agent id string or { agentId } object");
	}
	const agentId = (params as { agentId?: unknown }).agentId;
	if (typeof agentId !== "string" || !agentId.trim()) {
		throw new Error("pi.agents.select requires a non-empty agentId");
	}
	return agentId;
}

function assertNoWaitAgentsParams(params: unknown, apiName: string): void {
	const isEmptyObject =
		params !== null && typeof params === "object" && !Array.isArray(params) && Object.keys(params).length === 0;
	if (params === undefined || params === null || isEmptyObject) {
		return;
	}
	throw new Error(`${apiName} does not accept parameters`);
}

function isSupervisorOnlyAgentRequest(method: string): boolean {
	return method === "agents.spawn" || method === "agents.attachSession" || method === "agents.wait";
}

function createMainThreadSnapshot(): MainThreadSnapshot {
	return { displayName: "Main thread", id: MAIN_THREAD_AGENT_ID, lifecycle: "current", selected: true };
}

function findLastSessionMessage(entries: SessionEntry[]): LastMessageDetails | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type === "message") {
			return summarizeSessionMessage(entry);
		}
	}
	return null;
}

function summarizeSessionMessage(entry: Extract<SessionEntry, { type: "message" }>): LastMessageDetails {
	const message = entry.message as { content?: unknown; role?: unknown };
	const text = summarizeMessageContent(message.content);
	const details: LastMessageDetails = {
		entryId: entry.id,
		role: typeof message.role === "string" ? message.role : "unknown",
	};
	if (text !== undefined) {
		details.content = text.value;
		details.text = text.value;
		if (text.truncated) {
			details.truncated = true;
		}
	}
	return details;
}

function summarizeMessageContent(content: unknown): { truncated: boolean; value: string } | undefined {
	if (typeof content === "string") {
		return truncateText(content);
	}
	if (!Array.isArray(content)) {
		return undefined;
	}
	// Signed narration is public text the user saw; private thinking stays out.
	const text = content
		.map((item) => (item && typeof item === "object" ? getAssistantContentText(item as AssistantContent) : undefined))
		.filter((item): item is string => typeof item === "string")
		.join("\n");
	return text ? truncateText(text) : undefined;
}

function truncateText(text: string): { truncated: boolean; value: string } {
	if (text.length <= MESSAGE_CONTENT_LIMIT) {
		return { truncated: false, value: text };
	}
	return { truncated: true, value: text.slice(0, MESSAGE_CONTENT_LIMIT) };
}

function recoverAgents(input: Omit<AttachSessionDispatchInput, "prompt" | "target">): void {
	const activeAgents = input.ctx.multiAgentAgentId
		? input.store.listActiveAgents().filter((agent) => agent.parentId === input.ctx.multiAgentAgentId)
		: input.store.listActiveAgents();
	for (const agent of orderRecoveryAgents(activeAgents)) recoverAgent(input, agent);
}

function orderRecoveryAgents(agents: AgentSnapshot[]): AgentSnapshot[] {
	const byId = new Map(agents.map((agent) => [agent.id, agent]));
	const depths = new Map<string, number>();
	const depthOf = (agent: AgentSnapshot): number => {
		const cached = depths.get(agent.id);
		if (cached !== undefined) return cached;
		const parent = agent.parentId ? byId.get(agent.parentId) : undefined;
		const depth = parent ? depthOf(parent) + 1 : 0;
		depths.set(agent.id, depth);
		return depth;
	};
	return [...agents].sort((left, right) => depthOf(right) - depthOf(left));
}

function recoverAgent(input: Omit<AttachSessionDispatchInput, "prompt" | "target">, agent: AgentSnapshot): void {
	if (input.dispatches.has(agent.id)) return;
	if (!isInFlightLifecycle(agent.lifecycle)) return;
	if (agent.lifecycle !== "cancelling" && agent.transcript?.host) {
		const createAttachedSession = createRemoteAttachedSessionFactory(input.store);
		dispatchAttachedSessionAgent({ ...input, createAttachedSession, prompt: CRASH_RECOVERY_PROMPT, target: agent });
		return;
	}
	if (agent.lifecycle !== "cancelling" && input.createAttachedSession && agent.transcript?.path) {
		dispatchAttachedSessionAgent({ ...input, prompt: CRASH_RECOVERY_PROMPT, target: agent });
		return;
	}
	if (hasLiveAgentOwner(input, agent)) return;
	if (agent.lifecycle === "cancelling") {
		resolveDeadAgentRuntime(input, agent);
		return;
	}
	if (agent.transcript?.path) return;
	resolveDeadAgentRuntime(input, agent);
}

function resolveDeadAgentRuntime(
	input: Omit<AttachSessionDispatchInput, "prompt" | "target">,
	agent: AgentSnapshot,
): void {
	const persistence = input.store.getPersistenceTarget();
	if (!persistence) return;
	const coordinator = createLifecycleCoordinator(input.store);
	if (!coordinator) return;
	const deadOwnership = readMultiAgentRuntimeOwnership(persistence.controlDbPath, persistence.sessionPath, agent.id);
	if (!deadOwnership) return;
	const ownerSessionId = input.ctx.sessionManager?.getSessionId() ?? persistence.sessionPath;
	const recovered = coordinator.recoverDeadChild({
		agent,
		ownerSessionId,
		ownership: deadOwnership,
		supervisorAgentId: input.ctx.multiAgentAgentId,
	});
	if (recovered.ok) publishCoordinatorSnapshot(input.store, recovered.agent);
}

function hasLiveAgentOwner(
	input: Omit<AttachSessionDispatchInput, "prompt" | "target">,
	agent: AgentSnapshot,
): boolean {
	const persistence = input.store.getPersistenceTarget();
	if (!persistence) return false;
	const ownership = readMultiAgentRuntimeOwnership(persistence.controlDbPath, persistence.sessionPath, agent.id);
	if (!ownership?.processIdentity) return false;
	if (isSupersededRuntimeIdentity(ownership.processIdentity, RUNTIME_PROCESS_IDENTITY)) return false;
	return isProcessIdentityAlive(ownership.processIdentity);
}

function listAgents(store: MultiAgentStore, params: ListAgentsParams): AgentToolResult<AgentListToolDetails> {
	const agents = listMatchingAgents(store, params);

	return result(formatAgentListContent(agents), {
		activeCount: store.getActiveAgentCount(),
		agents,
	});
}

function formatAgentListContent(agents: AgentSnapshot[]): string {
	const header = `Found ${agents.length} agent${agents.length === 1 ? "" : "s"}.`;
	const entries = agents.map(
		(agent) =>
			`id=${agent.id} name=${JSON.stringify(agent.displayName)} type=${agent.agentType} status=${agentStatusLabel(agent)} lifecycle=${agent.lifecycle}`,
	);
	return [header, ...entries].join("\n");
}

function agentStatusLabel(agent: AgentSnapshot): "active" | "terminal" {
	return isActiveLifecycle(agent.lifecycle) ? "active" : "terminal";
}

function listMatchingAgents(store: MultiAgentStore, params: ListAgentsParams): AgentSnapshot[] {
	const agents = params.parentId ? store.listDescendants(params.parentId) : store.listAgents();
	return agents.filter((agent) => isActiveLifecycle(agent.lifecycle));
}

function isInFlightLifecycle(lifecycle: AgentSnapshot["lifecycle"]): boolean {
	return isActiveLifecycle(lifecycle) && lifecycle !== "waiting_for_input";
}

function contactParent(
	store: MultiAgentStore,
	params: ContactParentMessageParams,
	ctx?: ExtensionContext,
): AgentToolResult<ContactParentToolDetails> {
	const currentAgentId = ctx?.multiAgentAgentId;
	if (!currentAgentId) {
		return result("Could not contact parent: agent runtime identity is unavailable.", {
			agent: emptyAgent(""),
			message: failedMessage("", "", "parent_request", params.message),
		});
	}
	const contacted = store.contactParent(currentAgentId, {
		fileRefs: params.fileRefs,
		body: params.message,
		threadId: params.threadId,
	});
	if (!contacted.ok) {
		return result(`Could not contact parent for ${currentAgentId}: ${contacted.error}`, {
			agent: "current" in contacted ? contacted.current : emptyAgent(currentAgentId),
			message: failedMessage(currentAgentId, "", "parent_request", params.message),
		});
	}

	if (!mirrorRuntimeMailboxMessage(store, contacted.message, ctx)) {
		const failedMessage = markFailedMailboxTransportMessage(store, contacted.message);
		return result("Could not contact parent: runtime mailbox transport is unavailable.", {
			agent: contacted.agent,
			message: failedMessage,
		});
	}

	return result(`Contacted parent for ${contacted.agent.displayName}.`, {
		agent: contacted.agent,
		message: contacted.message,
	});
}

export function wakeWaitAgentsAfterCoordination(runtimeHandles: MultiAgentRuntimeHandles, prompt: string): void {
	for (const listener of runtimeHandles.waitWakeListeners) {
		listener({ coordinationPrompt: prompt, kind: "coordination" });
	}
}

interface RuntimeLifecycleMirror {
	bind(ctx: ExtensionContext): void;
	dispose(): void;
}

function createRuntimeLifecycleMirror(store: MultiAgentStore): RuntimeLifecycleMirror {
	let boundCtx: ExtensionContext | undefined;
	let boundSessionId: string | undefined;
	let unsubscribe: (() => void) | undefined;
	const dispose = () => {
		unsubscribe?.();
		boundCtx = undefined;
		unsubscribe = undefined;
		boundSessionId = undefined;
	};
	return {
		bind(ctx) {
			const sessionManager = ctx.sessionManager;
			if (!sessionManager || typeof sessionManager.getSessionId !== "function") return;
			const sessionId = sessionManager.getSessionId();
			boundCtx = ctx;
			if (boundSessionId === sessionId && unsubscribe) return;
			unsubscribe?.();
			boundSessionId = sessionId;
			unsubscribe = store.subscribeLifecycleNotifications((message) => {
				if (!boundCtx) return;
				try {
					void boundCtx.controlDbPath;
				} catch (error) {
					if (error instanceof Error && /\bstale\b/i.test(error.message)) {
						dispose();
						return;
					}
					throw error;
				}
				mirrorLifecycleRuntimeMailboxMessage(store, message, boundCtx);
			});
			mirrorPendingLifecycleRuntimeMailboxMessages(store, ctx);
		},
		dispose,
	};
}

export function resolveMultiAgentStore(options: MultiAgentExtensionOptions = {}): MultiAgentStore {
	return options.store ?? new MultiAgentStore();
}

function stopAgentDispatches(
	background: BackgroundDispatchContext,
	waitingDesktopNotifications: WaitingDesktopNotificationHandles,
): void {
	background.store.invalidateInFlightDispatches();
	for (const runtime of background.ownerships.values()) runtime.abortController.abort();
	for (const agentId of background.handles.keys()) {
		if (!background.ownerships.has(agentId)) abortAgentHandleSafely(background.store, agentId);
	}
	for (const agentId of waitingDesktopNotifications.keys()) {
		closeWaitingDesktopNotification(agentId, waitingDesktopNotifications);
	}
	background.handles.clear();
	background.dispatches.clear();
}

export function registerAgentsCoreTools(pi: ExtensionAPI, options: MultiAgentExtensionOptions = {}) {
	const store = resolveMultiAgentStore(options);
	const desktopNotifier = options.desktopNotifier ?? sendDesktopNotification;
	const runtimeHandles = options.runtimeHandles ?? createMultiAgentRuntimeHandles();
	const waitingDesktopNotifications: WaitingDesktopNotificationHandles = new Map();
	const backgroundDispatch = {
		createChildSession: options.createChildSession,
		dispatches: runtimeHandles.dispatches,
		handles: runtimeHandles.sessions,
		ownerships: runtimeHandles.ownerships,
		store,
	};
	const runtimeLifecycleMirror = createRuntimeLifecycleMirror(store);

	pi.on?.("model_request_start", (_event, ctx) => {
		if (!isChildAgentRuntime(ctx)) runtimeHandles.latestModelRequestStartedAt = Date.now();
	});
	// The wait slice bounds a foreground turn; idle waits (goal reviews) are bounded by their caller.
	pi.on?.("agent_end", (_event, ctx) => {
		if (!isChildAgentRuntime(ctx)) runtimeHandles.latestModelRequestStartedAt = undefined;
	});

	pi.on?.("session_start", async (_event, ctx) => {
		if (!isChildAgentRuntime(ctx)) {
			runtimeHandles.latestModelRequestStartedAt = undefined;
			runtimeLifecycleMirror.bind(ctx);
		}
		recoverAgents({
			createAttachedSession: options.createAttachedSession,
			ctx,
			desktopNotifier,
			dispatches: runtimeHandles.dispatches,
			handles: runtimeHandles.sessions,
			ownerships: runtimeHandles.ownerships,
			store,
			waitingDesktopNotifications,
		});
	});
	const unsubscribeCloseAll = pi.events?.on(CLOSE_ALL_AGENTS_EVENT, (payload) => {
		const request = payload as CloseAllAgentsRequest;
		request.closed ??= closeAllAgents(store, runtimeHandles, request);
	});
	pi.on?.("session_shutdown", async (event, ctx) => {
		unsubscribeCloseAll?.();
		runtimeLifecycleMirror.dispose();
		if (event.reason === "reload" || isChildAgentRuntime(ctx)) {
			return;
		}
		stopAgentDispatches(backgroundDispatch, waitingDesktopNotifications);
	});

	pi.registerCommand("bg", {
		description: "Run a prompt as a background agent job.",
		handler: async (args, ctx) => {
			runtimeLifecycleMirror.bind(ctx);
			return backgroundCommand(backgroundDispatch, args, ctx);
		},
	});

	pi.registerCommand("jobs", {
		description: "List background agent jobs.",
		handler: async (_args, ctx) => jobsCommand(store, ctx),
	});

	pi.registerTool(
		defineTool({
			name: "spawn_agent",
			label: "Spawn Agent",
			description:
				"Create a child agent record and optionally dispatch it through the multi-agent runtime on a pi server host.",
			promptGuidelines: [
				'For read-only codebase research or exploration, prefer spawn_agent with agentType "explore".',
				'Child agents can only request one read-only "explore" consultation at a time. Omit parentId; the tool waits for the consultation to finish and the result arrives through the mailbox.',
				'In main sessions, context defaults to "inherit"; choose "fresh" explicitly for isolated work, verification, or falsification. Reviewer profiles default to fresh context. Set host to run the child on another pi server machine.',
				'In main sessions, use agentType "implement" for scoped code changes, "verifier" for proof commands before completion, and "reviewer" for final code review or second opinions.',
			],
			approvalRequired: false,
			parameters: spawnAgentSchema,
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				if (!isChildAgentRuntime(ctx)) runtimeLifecycleMirror.bind(ctx);
				return spawnAgent(
					store,
					options.createChildSession,
					runtimeHandles.dispatches,
					runtimeHandles.ownerships,
					params,
					ctx,
					desktopNotifier,
					waitingDesktopNotifications,
					runtimeHandles.sessions,
					_toolCallId,
					signal,
				);
			},
		}),
	);

	registerSetAgentModelTool(pi, store, runtimeHandles.sessions);

	pi.registerTool(
		defineTool({
			name: "list_agents",
			label: "List Agents",
			description: "List agents from the authoritative multi-agent store.",
			approvalRequired: false,
			parameters: listAgentsSchema,
			execute: async (_toolCallId, params) => listAgents(store, params),
		}),
	);

	pi.registerTool(
		defineTool({
			name: "attach_session_agent",
			label: "Attach Session Agent",
			description: "Attach or resume an existing saved session as an agent without changing its session ID.",
			approvalRequired: false,
			parameters: attachSessionAgentSchema,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				runtimeLifecycleMirror.bind(ctx);
				return attachSessionAgent({
					createAttachedSession: options.createAttachedSession,
					ctx,
					desktopNotifier,
					dispatches: runtimeHandles.dispatches,
					handles: runtimeHandles.sessions,
					params,
					ownerships: runtimeHandles.ownerships,
					store,
					waitingDesktopNotifications,
				});
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "wait_agent",
			label: "Wait Agent",
			description:
				"Wait until an active agent terminates, steering wakes the wait, persisted coordination polling finds input, or 25 minutes elapse since the latest model request started. Timeout leaves agents running. Terminal wakes consume pending terminal notifications.",
			approvalRequired: false,
			parameters: waitAgentsSchema,
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				runtimeLifecycleMirror.bind(ctx);
				assertNoWaitAgentsParams(params, "wait_agent");
				return waitAgents(store, runtimeHandles, signal, ctx);
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "close_agent",
			label: "Close Agent",
			description: "Close an agent through the multi-agent store using the current store revision.",
			approvalRequired: false,
			parameters: cancelAgentSchema,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
				cancelAgent(
					store,
					runtimeHandles,
					params,
					ctx.sessionManager?.getSessionId() ?? store.getPersistenceTarget()?.sessionPath ?? "",
				),
		}),
	);

	pi.registerTool(
		defineTool({
			name: "steer_agent",
			label: "Steer Agent",
			description: "Queue a steering message through the multi-agent mailbox.",
			approvalRequired: false,
			parameters: steerAgentSchema,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
				steerAgent(store, runtimeHandles, params, ctx),
		}),
	);
}

export function registerAgentsMailboxTools(pi: ExtensionAPI, options: MultiAgentExtensionOptions = {}) {
	const store = resolveMultiAgentStore(options);

	registerModelMailboxTools(pi, {
		contactParent: (params, ctx) => contactParent(store, params, ctx),
		sendAgentMessage: (params, ctx) => sendAgentMessage(store, params, ctx, options.onSessionMessageSent),
	});
	registerQuestionRelayTools(pi, store, { contactParent: (params, ctx) => contactParent(store, params, ctx) });
}

export default function multiAgentExtension(pi: ExtensionAPI, options: MultiAgentExtensionOptions = {}) {
	const store = resolveMultiAgentStore(options);
	const sharedOptions = { ...options, store };

	registerAgentsCoreTools(pi, sharedOptions);
	registerAgentViewerTools(pi, sharedOptions);
	registerAgentsMailboxTools(pi, sharedOptions);
}
