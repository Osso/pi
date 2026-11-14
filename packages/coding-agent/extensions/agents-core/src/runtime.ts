export type { MultiAgentRuntimeHandles, WaitNotificationsWake } from "./contracts.ts";

export {
	createProductionAttachedSessionFactory,
	createProductionChildAgentSessionFactory,
} from "./session-factories.ts";

import type { AttachSessionDispatchInput } from "./attachment.ts";
import { attachSessionAgent, dispatchAttachedSessionAgent } from "./attachment.ts";
import type { BackgroundDispatchContext } from "./dispatch.ts";
import { backgroundCommand, formatAgentStatus, isChildAgentRuntime, spawnAgent } from "./dispatch.ts";
import type { WaitingDesktopNotificationHandles } from "./dispatch-pipeline.ts";
import { closeWaitingDesktopNotification, publishCoordinatorSnapshot } from "./dispatch-pipeline.ts";
import {
	createMultiAgentRuntimeHandles,
	mirrorLifecycleRuntimeMailboxMessage,
	mirrorPendingLifecycleRuntimeMailboxMessages,
	waitAgents,
} from "./wait.ts";

export { deliverTerminalOutboxForStore } from "./dispatch-pipeline.ts";
export {
	consumeNotifications,
	createMultiAgentRuntimeHandles,
	waitNotifications,
} from "./wait.ts";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { sendDesktopNotification } from "../../../src/core/desktop-notification.ts";
import {
	type AgentToolResult,
	defineTool,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ViewedSessionMutationTarget,
} from "../../../src/core/extensions/types.ts";
import {
	type AgentFileReference,
	type AgentMailboxMessage,
	type AgentSnapshot,
	isActiveLifecycle,
	MultiAgentStore,
	type SteeringCheckpoint,
} from "../../../src/core/multi-agent-store.ts";
import { isProcessIdentityAlive, isSupersededRuntimeIdentity } from "../../../src/core/runtime-process.ts";
import {
	readMultiAgentRuntimeOwnership,
	releaseRuntimeMailboxMessageClaim,
} from "../../../src/core/session-control-db.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import { registerAgentViewerTools } from "../../agent-viewer/src/runtime.ts";
import { registerSetAgentModelTool, resolveLiveAgentMutationTarget } from "./agent-model-tool.ts";
import type { MultiAgentRuntimeHandles } from "./contracts.ts";
import {
	type DetachedRuntimeCancellationOptions,
	readDetachedRuntimeAgentIds,
	requestPersistedDetachedRuntimeCancellation,
} from "./detached-runtime-cancellation.ts";
import { createLifecycleCoordinator, RUNTIME_PROCESS_IDENTITY } from "./lifecycle-runtime.ts";
import {
	type ContactParentMessageParams,
	registerModelMailboxTools,
	type SendAgentMessageParams,
} from "./mailbox-tools.ts";
import {
	currentMessageSenderId,
	emptyAgent,
	failedMessage,
	markFailedMailboxTransportMessage,
	mirrorRuntimeMailboxMessage,
	result,
	sendAgentMessage,
} from "./messaging.ts";
import { registerQuestionRelayTools } from "./question-relay-tools.ts";

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
	type AgentSteerToolDetails,
	type AgentToolDetails,
	type AttachSessionAgentParams,
	attachSessionAgentSchema,
	CANCELLATION_SETTLEMENT_TIMEOUT_MS,
	type CancelAgentParams,
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
	type SteerAgentParams,
	spawnAgentSchema,
	steerAgentSchema,
	THINKING_LEVELS,
	waitAgentsSchema,
} from "./contracts.ts";

export function resolveSelectedSessionMutationTarget(
	store: MultiAgentStore,
	runtimeHandles: MultiAgentRuntimeHandles,
): ViewedSessionMutationTarget | undefined {
	const selectedAgentId = store.getSelectedAgentId();
	if (!selectedAgentId || selectedAgentId === MAIN_THREAD_AGENT_ID) return undefined;
	return resolveLiveAgentMutationTarget(store, runtimeHandles.sessions, selectedAgentId);
}

function jobsCommand(store: MultiAgentStore, ctx: ExtensionCommandContext): void {
	const agents = store.listAgents().filter((agent) => agent.agentType === "background");
	if (agents.length === 0) {
		ctx.ui.notify("No background jobs.", "info");
		return;
	}

	ctx.ui.notify(agents.map((agent) => `${agent.id} ${formatAgentStatus(agent)}`).join("\n"), "info");
}

/**
 * Model and effort a spawned child starts with: the profile's values, else the parent's model and medium effort,
 * independent of the parent's current effort, clamped to the model's capabilities. Recording both lets displays and
 * resumes show what the child runs.
 */
function _toThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
	return value && THINKING_LEVELS.has(value as ThinkingLevel) ? (value as ThinkingLevel) : undefined;
}

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
			const waited = await waitAgents(store, runtimeHandles, signal, ctx);
			// The bridge returns only a wake, not accepted session input. Leave coordination for the session checkpoint.
			const delivery = waited.details.runtimeMailboxDelivery;
			if (delivery) {
				for (const message of delivery.messages)
					releaseRuntimeMailboxMessageClaim(delivery.controlDbPath, message.id);
			}
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
			return selectAgent(store, request.params, options.selectAgentView);
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

function selectAgent(
	store: MultiAgentStore,
	params: unknown,
	selectAgentView: MultiAgentExtensionOptions["selectAgentView"],
): AgentSelectionDetails {
	const agentId = normalizeSelectAgentId(params);
	const rendered = selectAgentView?.(agentId);
	if (rendered === true) {
		if (agentId === MAIN_THREAD_AGENT_ID) return { agent: createMainThreadSnapshot() };
		const selected = store.getAgent(agentId);
		if (selected) return { agent: selected };
		return selectCurrentAgent(store);
	}
	if (rendered === false) throw new Error(`Agent view selection failed: ${agentId}`);

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
	const text = content
		.map((item) => (isTextContent(item) ? item.text : undefined))
		.filter((item): item is string => item !== undefined)
		.join("\n");
	return text ? truncateText(text) : undefined;
}

function isTextContent(item: unknown): item is { text: string; type: "text" } {
	if (!item || typeof item !== "object") {
		return false;
	}
	const content = item as { text?: unknown; type?: unknown };
	return content.type === "text" && typeof content.text === "string";
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

export type CancelReservedAgentResult =
	| { ok: true; agent: AgentSnapshot }
	| {
			ok: false;
			error: "agent_not_found" | "runtime_ownership_unavailable" | "mutation_rejected";
			agent?: AgentSnapshot;
	  };

export async function cancelOwnedAgentRuntime(
	store: MultiAgentStore,
	runtimeHandles: MultiAgentRuntimeHandles,
	agentId: string,
	ownerSessionId: string,
	reason?: string,
): Promise<CancelReservedAgentResult> {
	const descendants = store
		.listDescendants(agentId)
		.filter((agent) => isActiveLifecycle(agent.lifecycle))
		.reverse();
	const detachedRuntimeAgentIds = readDetachedRuntimeAgentIds(
		store,
		descendants.map((agent) => agent.id),
	);
	for (const descendant of descendants) {
		const cancelled = await cancelOneOwnedAgentRuntime(store, runtimeHandles, descendant.id, ownerSessionId, {
			reason,
			suppressTerminalNotification: detachedRuntimeAgentIds.has(descendant.id),
		});
		if (!cancelled.ok) return cancelled;
	}
	return cancelOneOwnedAgentRuntime(store, runtimeHandles, agentId, ownerSessionId, { reason });
}

function abortAgentHandleSafely(store: MultiAgentStore, agentId: string): void {
	try {
		store.abortAgentHandle(agentId);
	} catch (error) {
		console.error(`Failed to abort agent runtime ${agentId}:`, error);
	}
}

async function cancelOneOwnedAgentRuntime(
	store: MultiAgentStore,
	runtimeHandles: MultiAgentRuntimeHandles,
	agentId: string,
	ownerSessionId: string,
	options: DetachedRuntimeCancellationOptions,
): Promise<CancelReservedAgentResult> {
	const current = store.getAgent(agentId);
	if (!current) return { ok: false, error: "agent_not_found" };
	const reservedRuntime = runtimeHandles.ownerships.get(agentId);
	if (!reservedRuntime && current.lifecycle === "waiting_for_input") {
		return closeIdleAgentWithoutRuntime(store, current, ownerSessionId);
	}
	if (!reservedRuntime) return requestPersistedDetachedRuntimeCancellation(store, current, options);
	const cancelling = reservedRuntime.coordinator.requestCancellation({
		agent: current,
		ownership: reservedRuntime.lifecycle.ownership,
	});
	if (!cancelling.ok) return { ok: false, error: "mutation_rejected", agent: current };
	store.publishLifecycleCoordinatorSnapshot(cancelling.agent);
	abortAgentHandleSafely(store, agentId);
	const dispatch = runtimeHandles.dispatches.get(agentId);
	if (dispatch) {
		const timeoutMs = runtimeHandles.cancellationSettlementTimeoutMs ?? CANCELLATION_SETTLEMENT_TIMEOUT_MS;
		await Promise.race([
			dispatch.then(() => true),
			new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
		]);
	}
	const settled = store.getAgent(agentId) ?? cancelling.agent;
	return { ok: true, agent: settled };
}

/**
 * An idle agent with no runtime in this process, such as a session attached without a prompt
 * or one parked before a restart, has nothing to abort: take its ownership and record it aborted.
 * A live owner elsewhere keeps the agent.
 */
function closeIdleAgentWithoutRuntime(
	store: MultiAgentStore,
	agent: AgentSnapshot,
	ownerSessionId: string,
): CancelReservedAgentResult {
	const coordinator = createLifecycleCoordinator(store);
	const acquired = coordinator?.acquireAttachedRuntime(agent, ownerSessionId);
	if (!coordinator || !acquired?.ok) return { ok: false, error: "runtime_ownership_unavailable", agent };
	const aborted = coordinator.acknowledgeCancellation({ agent: acquired.agent, ownership: acquired.ownership });
	if (!aborted.ok) return { ok: false, error: "mutation_rejected", agent };
	store.publishLifecycleCoordinatorSnapshot(aborted.agent);
	return { ok: true, agent: aborted.agent };
}

async function cancelAgent(
	store: MultiAgentStore,
	runtimeHandles: MultiAgentRuntimeHandles,
	params: CancelAgentParams,
	ownerSessionId: string,
): Promise<AgentToolResult<AgentToolDetails>> {
	const cancelled = await cancelOwnedAgentRuntime(
		store,
		runtimeHandles,
		params.agentId,
		ownerSessionId,
		params.reason,
	);
	if (!cancelled.ok) {
		const error =
			cancelled.error === "runtime_ownership_unavailable" ? "runtime ownership unavailable" : cancelled.error;
		return result(`Could not cancel ${params.agentId}: ${error}`, {
			agent: cancelled.agent ?? emptyAgent(params.agentId),
			reason: params.reason,
		});
	}
	return result(
		cancelled.agent.lifecycle === "aborted"
			? `Cancelled ${cancelled.agent.displayName}.`
			: `Cancellation requested for ${cancelled.agent.displayName}.`,
		{ agent: cancelled.agent, reason: params.reason },
	);
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

export interface AgentSteeringRuntimeBinding {
	actorAgentId: string | null;
	controlDbPath: string;
	sessionId: string;
}

export interface AgentSteeringRequest {
	agentId: string;
	message: string;
	fileRefs?: AgentFileReference[];
	targetCheckpoint?: SteeringCheckpoint;
}

export type AgentSteeringRequestResult =
	| { ok: true; agent: AgentSnapshot; message: AgentMailboxMessage }
	| { ok: false; agent: AgentSnapshot; message: AgentMailboxMessage; error: string };

export function wakeWaitAgentsAfterCoordination(runtimeHandles: MultiAgentRuntimeHandles, prompt: string): void {
	for (const listener of runtimeHandles.waitWakeListeners) {
		listener({ coordinationPrompt: prompt, kind: "coordination" });
	}
}

export function wakeWaitAgentsAfterSteering(runtimeHandles: MultiAgentRuntimeHandles): void {
	for (const listener of runtimeHandles.waitWakeListeners) listener({ kind: "steering" });
}

export function requestInteractiveAgentSteering(
	store: MultiAgentStore,
	runtimeHandles: MultiAgentRuntimeHandles,
	agentId: string,
	message: string,
	binding: AgentSteeringRuntimeBinding,
): { ok: true } | { error: string; ok: false } {
	const steered = requestAgentSteering(
		store,
		{ agentId, message, targetCheckpoint: "next_model_call" },
		binding,
		runtimeHandles,
	);
	return steered.ok ? { ok: true } : { error: steered.error, ok: false };
}

export function requestAgentSteering(
	store: MultiAgentStore,
	params: AgentSteeringRequest,
	binding: AgentSteeringRuntimeBinding,
	runtimeHandles?: MultiAgentRuntimeHandles,
): AgentSteeringRequestResult {
	const senderId = binding.actorAgentId ?? "supervisor";
	const current = store.getAgent(params.agentId);
	if (!current) {
		return {
			agent: emptyAgent(params.agentId),
			error: `Could not steer ${params.agentId}: not_found`,
			message: failedMessage("supervisor", params.agentId, "steer", params.message),
			ok: false,
		};
	}
	if (!isActiveLifecycle(current.lifecycle)) {
		return {
			agent: current,
			error: `Could not steer ${params.agentId}: inactive (${current.lifecycle})`,
			message: failedMessage("supervisor", params.agentId, "steer", params.message),
			ok: false,
		};
	}

	const persistence = store.getPersistenceTarget();
	const coordinator = createLifecycleCoordinator(store);
	const ownership = persistence
		? readMultiAgentRuntimeOwnership(persistence.controlDbPath, persistence.sessionPath, current.id)
		: undefined;
	const expectedActorId = ownership?.owner.agentId ?? null;
	const targetSessionId = current.transcript?.sessionId;
	if (
		!coordinator ||
		!ownership ||
		!persistence ||
		persistence.controlDbPath !== binding.controlDbPath ||
		binding.actorAgentId !== expectedActorId ||
		binding.sessionId !== ownership.owner.sessionId ||
		!ownership.processIdentity ||
		!isProcessIdentityAlive(ownership.processIdentity) ||
		!targetSessionId
	) {
		return {
			agent: current,
			error: `Could not steer ${params.agentId}: runtime ownership unavailable`,
			message: failedMessage("supervisor", params.agentId, "steer", params.message),
			ok: false,
		};
	}
	const steered = coordinator.requestSteering({
		agent: current,
		body: params.message,
		fileRefs: params.fileRefs,
		fromAgentId: senderId,
		ownership,
		recipient: { agentId: current.id, sessionId: targetSessionId },
		targetCheckpoint: params.targetCheckpoint as SteeringCheckpoint | undefined,
	});
	if (!steered.ok) {
		const error = steered.error === "invalid_transition" ? "inactive" : steered.error;
		return {
			agent: current,
			error: `Could not steer ${params.agentId}: ${error}`,
			message: failedMessage("supervisor", params.agentId, "steer", params.message),
			ok: false,
		};
	}
	store.publishLifecycleCoordinatorSteering(steered.agent, steered.message);
	for (const listener of runtimeHandles?.waitWakeListeners ?? []) {
		listener({ agentId: steered.agent.id, kind: "steering" });
	}
	return { agent: steered.agent, message: steered.message, ok: true };
}

function steerAgent(
	store: MultiAgentStore,
	runtimeHandles: MultiAgentRuntimeHandles,
	params: SteerAgentParams,
	ctx?: ExtensionContext,
): AgentToolResult<AgentSteerToolDetails> {
	const persistence = store.getPersistenceTarget();
	const controlDbPath = ctx?.controlDbPath ?? persistence?.controlDbPath;
	const senderId = currentSteeringSenderId(store, ctx);
	if (!ctx || !controlDbPath || !senderId) {
		return result("Could not steer agent: subagent runtime identity is unavailable.", {
			agent: emptyAgent(params.agentId),
			message: failedMessage("supervisor", params.agentId, "steer", params.message),
		});
	}
	const steered = requestAgentSteering(
		store,
		params,
		{
			actorAgentId: senderId === "supervisor" ? null : senderId,
			controlDbPath,
			sessionId: ctx.sessionManager?.getSessionId() ?? persistence?.sessionPath ?? "",
		},
		runtimeHandles,
	);
	if (!steered.ok) {
		return result(steered.error, { agent: steered.agent, message: steered.message });
	}
	return result(`Queued steering for ${steered.agent.displayName}.`, {
		agent: steered.agent,
		message: steered.message,
	});
}

function currentSteeringSenderId(store: MultiAgentStore, ctx: ExtensionContext | undefined): string | undefined {
	const senderId = currentMessageSenderId(store, ctx);
	if (!senderId) {
		return undefined;
	}
	return senderId === MAIN_THREAD_AGENT_ID ? "supervisor" : senderId;
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
	pi.on?.("session_shutdown", async (event, ctx) => {
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
			description: "Create a child agent record and optionally dispatch it through the multi-agent runtime.",
			promptGuidelines: [
				'For read-only codebase research or exploration, prefer spawn_agent with agentType "explore".',
				'Context defaults to "inherit"; choose "fresh" explicitly for isolated work, verification, or falsification. Reviewer profiles default to fresh context.',
				'For scoped code changes, use agentType "implement"; for proof commands before completion, use agentType "verifier"; for final code review or second opinions, use agentType "reviewer".',
			],
			approvalRequired: false,
			parameters: spawnAgentSchema,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				runtimeLifecycleMirror.bind(ctx);
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
