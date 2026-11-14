export type { MultiAgentRuntimeHandles } from "./contracts.ts";

export {
	createProductionAttachedSessionFactory,
	createProductionChildAgentSessionFactory,
} from "./session-factories.ts";

import type { WaitingDesktopNotificationHandles } from "./dispatch-pipeline.ts";
import {
	closeWaitingDesktopNotification,
	publishCoordinatorSnapshot,
	runAgentSession,
	startToolDispatch,
	trackAgentDispatch,
} from "./dispatch-pipeline.ts";

export { deliverTerminalOutboxForStore } from "./dispatch-pipeline.ts";

import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import { DEFAULT_THINKING_LEVEL } from "../../../src/core/defaults.ts";
import { sendDesktopNotification } from "../../../src/core/desktop-notification.ts";
import {
	type AgentToolResult,
	defineTool,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ViewedSessionMutationTarget,
} from "../../../src/core/extensions/types.ts";
import { LifecycleCoordinator, type OwnedLifecycleCommandInput } from "../../../src/core/lifecycle-coordinator.ts";
import { findExactModelReferenceMatch } from "../../../src/core/model-resolver.ts";
import {
	type AgentFileReference,
	type AgentMailboxMessage,
	type AgentSnapshot,
	isActiveLifecycle,
	MultiAgentStore,
	type PendingLifecycleNotification,
	type SteeringCheckpoint,
} from "../../../src/core/multi-agent-store.ts";
import {
	formatRuntimeMailboxPrompt,
	formatSharedChannelPrompt,
} from "../../../src/core/runtime-coordination-format.ts";
import type { RuntimeMailboxToolDelivery } from "../../../src/core/runtime-mailbox-acceptance.ts";
import { isProcessIdentityAlive, isSupersededRuntimeIdentity } from "../../../src/core/runtime-process.ts";
import { restoreArchivedSession } from "../../../src/core/session-archive-storage.ts";
import {
	advanceSharedChannelCursor,
	enqueueRuntimeMailboxMessage,
	hasPendingRuntimeCoordinationMessage,
	isRuntimeCoordinationMailboxMessage,
	listSharedChannelMessagesAfter,
	type RuntimeMailboxAddress,
	readActiveMultiAgentAgents,
	readMultiAgentAgents,
	readMultiAgentRuntimeOwnership,
	readSessionMetadata,
	readSharedChannelCursor,
	readSharedChannelTail,
	releaseRuntimeMailboxMessageClaim,
	resolveOwnMainRuntimeCoordinationRecipient,
	type SharedChannelMessage,
	takeRuntimeMailboxMessagesForDelivery,
} from "../../../src/core/session-control-db.ts";
import { type SessionEntry, type SessionInfo, SessionManager } from "../../../src/core/session-manager.ts";
import { deliverTerminalOutboxProjections } from "../../../src/core/terminal-outbox-delivery.ts";
import { registerAgentViewerTools } from "../../agent-viewer/src/runtime.ts";
import { registerSetAgentModelTool, resolveLiveAgentMutationTarget } from "./agent-model-tool.ts";
import { type AttachSessionInfo, findAttachSessionsById, readStoredSessionModel } from "./attach-session-lookup.ts";
import type {
	ActiveAgentDispatches,
	BackgroundSessionHandles,
	MultiAgentRuntimeHandles,
	OwnedAgentRuntime,
} from "./contracts.ts";
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
	buildRuntimeMailboxStoreRef,
	currentMessageSenderId,
	emptyAgent,
	failedMessage,
	markFailedMailboxTransportMessage,
	mirrorRuntimeMailboxMessage,
	resolveRuntimeRecipient,
	result,
	sendAgentMessage,
} from "./messaging.ts";
import { registerQuestionRelayTools } from "./question-relay-tools.ts";
import {
	artifactRootForStore,
	isProductionChildSessionFactory,
	spawnPromptValidationMessage,
	validateGoalObjective,
} from "./session-factories.ts";

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
	type AgentDesktopNotifier,
	type AgentListToolDetails,
	type AgentSelectionDetails,
	type AgentSteerToolDetails,
	type AgentToolDetails,
	type AttachedSessionFactory,
	type AttachSessionAgentParams,
	attachSessionAgentSchema,
	CANCELLATION_SETTLEMENT_TIMEOUT_MS,
	type CancelAgentParams,
	CHILD_ORCHESTRATION_UNAVAILABLE_MESSAGE,
	type ChildAgentDispatchInput,
	type ChildAgentSession,
	type ChildAgentSessionFactory,
	type ContactParentToolDetails,
	CRASH_RECOVERY_PROMPT,
	cancelAgentSchema,
	type GoalObjectiveValidation,
	type LastMessageDetails,
	type ListAgentsParams,
	listAgentsSchema,
	MAIN_THREAD_AGENT_ID,
	MAX_GOAL_OBJECTIVE_CHARS,
	type MainThreadSnapshot,
	MESSAGE_CONTENT_LIMIT,
	type MultiAgentExtensionOptions,
	type MultiAgentPiRequestHandler,
	type ResolvedAgentProfile,
	RUNTIME_COORDINATION_POLL_INTERVAL_MS,
	requireSpawnAgentParams,
	type SteerAgentParams,
	spawnAgentSchema,
	steerAgentSchema,
	THINKING_LEVELS,
	WAIT_AGENT_SLICE_MS,
	type WaitAgentsToolDetails,
	type WaitAgentsWakeUp,
	waitAgentsSchema,
} from "./contracts.ts";

export function createMultiAgentRuntimeHandles(): MultiAgentRuntimeHandles {
	return { dispatches: new Map(), ownerships: new Map(), sessions: new Map(), waitWakeListeners: new Set() };
}

export function resolveSelectedSessionMutationTarget(
	store: MultiAgentStore,
	runtimeHandles: MultiAgentRuntimeHandles,
): ViewedSessionMutationTarget | undefined {
	const selectedAgentId = store.getSelectedAgentId();
	if (!selectedAgentId || selectedAgentId === MAIN_THREAD_AGENT_ID) return undefined;
	return resolveLiveAgentMutationTarget(store, runtimeHandles.sessions, selectedAgentId);
}

interface BackgroundDispatchContext {
	createChildSession: ChildAgentSessionFactory | undefined;
	dispatches: ActiveAgentDispatches;
	handles: BackgroundSessionHandles;
	ownerships: Map<string, OwnedAgentRuntime>;
	store: MultiAgentStore;
}

function emptyResult(): AgentToolResult<Record<string, never>> {
	return { content: [], details: {} };
}

function notifyBackgroundDispatch(
	promise: Promise<AgentSnapshot>,
	handles: BackgroundSessionHandles,
	ctx: ExtensionCommandContext,
): void {
	void promise.then((agent) => {
		handles.delete(agent.id);
		const level = agent.lifecycle === "completed" ? "info" : agent.lifecycle === "failed" ? "error" : "warning";
		ctx.ui.notify(formatAgentStatus(agent), level);
	});
}

function backgroundPromptValidationMessage(validation: Exclude<GoalObjectiveValidation, { ok: true }>): string {
	return validation.reason === "empty"
		? "Usage: /bg <prompt>"
		: `Objective too long (${validation.length} > ${MAX_GOAL_OBJECTIVE_CHARS} chars)`;
}

function startBackgroundDispatch(
	background: BackgroundDispatchContext,
	runtime: OwnedAgentRuntime,
	prompt: string,
	ctx: ExtensionCommandContext,
	createdSession?: ChildAgentSession,
): AgentSnapshot {
	const agent = runtime.lifecycle.agent;
	if (background.createChildSession) {
		const promise = trackAgentDispatch(
			background.store,
			background.dispatches,
			agent,
			runAgentSession(
				background.store,
				background.createChildSession,
				agent,
				prompt,
				ctx,
				background.handles,
				createdSession,
				runtime,
			),
			runtime,
			background.handles,
		);
		notifyBackgroundDispatch(promise, background.handles, ctx);
		void promise.finally(() => background.ownerships.delete(agent.id));
		return background.store.getAgent(agent.id) ?? agent;
	}

	return agent;
}

async function backgroundCommand(
	background: BackgroundDispatchContext,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (isChildAgentRuntime(ctx)) {
		ctx.ui.notify(CHILD_ORCHESTRATION_UNAVAILABLE_MESSAGE, "error");
		return;
	}
	const prompt = args.trim();
	if (!background.createChildSession) {
		ctx.ui.notify("Background jobs are unavailable: no child session runtime is configured.", "error");
		return;
	}
	if (isProductionChildSessionFactory(background.createChildSession)) {
		const validation = validateGoalObjective(prompt);
		if (!validation.ok) {
			ctx.ui.notify(backgroundPromptValidationMessage(validation), "error");
			return;
		}
	}

	const coordinator = createLifecycleCoordinator(background.store);
	if (!coordinator) {
		ctx.ui.notify("Background jobs require a persisted supervisor session.", "error");
		return;
	}
	let prepared = coordinator.prepareChild({
		agentType: "background",
		cwd: ctx.cwd,
		displayName: "Background Job",
		permission: { narrowed: true, policy: "on-request" },
	});
	const abortController = new AbortController();
	let childSession: ChildAgentSession | undefined;
	if (background.createChildSession) {
		try {
			childSession = await background.createChildSession({
				agent: prepared,
				context: "fresh",
				ctx,
				prompt,
				signal: abortController.signal,
			});
		} catch (error) {
			const runtimeError = {
				code: "runtime_spawn_failed",
				message: error instanceof Error ? error.message : String(error),
			};
			const failed = coordinator.commitFailedChild(prepared, runtimeError);
			if (failed.ok) publishCoordinatorSnapshot(background.store, failed.agent);
			ctx.ui.notify(`Could not create background job: ${runtimeError.message}`, "error");
			return;
		}
		if (childSession.transcript) prepared = { ...prepared, transcript: childSession.transcript };
	}
	const created = coordinator.commitRunningChild(
		prepared,
		ctx.sessionManager?.getSessionId() ?? background.store.getPersistenceTarget()?.sessionPath ?? "",
	);
	if (!created.ok) {
		await childSession?.dispose?.();
		ctx.ui.notify(`Could not create background job: ${created.error}`, "error");
		return;
	}
	background.store.publishLifecycleCoordinatorSnapshot(created.agent);
	const runtime = {
		abortController,
		coordinator,
		lifecycle: { agent: created.agent, ownership: created.ownership },
	};
	background.ownerships.set(created.agent.id, runtime);
	const agent = startBackgroundDispatch(background, runtime, prompt, ctx, childSession);
	ctx.ui.setEditorText("");
	ctx.ui.notify(
		`Background job ${agent.id} started. Use /jobs to inspect it or wait_agent to wait for any completion.`,
		"info",
	);
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
function spawnModelMetadata(profile: ResolvedAgentProfile | undefined, ctx: ExtensionContext): AgentSnapshot["model"] {
	const model = profile?.model ?? ctx.model;
	if (!model) return undefined;
	const thinkingLevel = clampThinkingLevel(model, profile?.thinkingLevel ?? DEFAULT_THINKING_LEVEL) as ThinkingLevel;
	return { providerId: model.provider, modelId: model.id, thinkingLevel };
}

function resolveConfiguredAgentProfile(agentType: string, ctx: ExtensionContext): ResolvedAgentProfile | undefined {
	const profile = ctx.settingsManager?.getAgentProfile(agentType);
	if (!profile) {
		return undefined;
	}

	const model = profile.model ? findExactModelReferenceMatch(profile.model, ctx.modelRegistry.getAll()) : undefined;
	return {
		context: profile.context,
		model,
		modelMetadata: model
			? { providerId: model.provider, modelId: model.id, thinkingLevel: profile.thinkingLevel }
			: undefined,
		thinkingLevel: profile.thinkingLevel,
		tools: profile.tools,
	};
}

function requireConfiguredAgentProfile(
	agentType: string,
	requestedAgentType: string | undefined,
	ctx: ExtensionContext,
): ResolvedAgentProfile | undefined {
	const profile = resolveConfiguredAgentProfile(agentType, ctx);
	if (!requestedAgentType) return profile;
	if (!ctx.settingsManager) return profile;
	if (profile) return profile;

	const configuredAgentTypes = Object.keys(ctx.settingsManager.getMergedSettings().agents ?? {}).sort();
	const guidance =
		configuredAgentTypes.length > 0
			? `Configured agent profiles: ${configuredAgentTypes.join(", ")}. Use one of these profile keys or omit agentType to inherit the parent model.`
			: "Configure the profile under settings.agents or omit agentType to inherit the parent model.";
	throw new Error(`Unknown agent type ${JSON.stringify(agentType)}. ${guidance}`);
}

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

function isChildAgentRuntime(ctx: ExtensionContext): boolean {
	return ctx.multiAgentAgentId !== undefined || ctx.multiAgentRequiresAgentId === true;
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

async function spawnAgent(
	store: MultiAgentStore,
	createChildSession: ChildAgentSessionFactory | undefined,
	dispatches: ActiveAgentDispatches,
	ownerships: Map<string, OwnedAgentRuntime>,
	params: unknown,
	ctx: ExtensionContext,
	desktopNotifier: AgentDesktopNotifier,
	waitingDesktopNotifications: WaitingDesktopNotificationHandles,
	handles?: BackgroundSessionHandles,
	activeToolCallId?: string,
): Promise<AgentToolResult<AgentToolDetails>> {
	requireSpawnAgentParams(params);
	if (isChildAgentRuntime(ctx)) {
		return result(CHILD_ORCHESTRATION_UNAVAILABLE_MESSAGE, {
			agent: emptyAgent("spawn_agent"),
			dispatched: false,
			prompt: params.prompt,
		});
	}
	if (isProductionChildSessionFactory(createChildSession)) {
		const validation = validateGoalObjective(params.prompt);
		if (!validation.ok) {
			return result(spawnPromptValidationMessage(validation), {
				agent: emptyAgent("spawn_agent"),
				dispatched: false,
				prompt: params.prompt,
			});
		}
	}
	if (!createChildSession) {
		return result("spawn_agent is unavailable: no child session runtime is configured.", {
			agent: emptyAgent("spawn_agent"),
			dispatched: false,
			prompt: params.prompt,
		});
	}
	const requestedAgentType = params.agentType?.trim();
	const displayName = params.displayName?.trim() || requestedAgentType || "Agent";
	const agentType = requestedAgentType || "default";
	const profile = requireConfiguredAgentProfile(agentType, requestedAgentType, ctx);
	const context = params.context ?? profile?.context ?? "inherit";
	const coordinator = createLifecycleCoordinator(store);
	if (!coordinator) {
		return result("spawn_agent requires a persisted supervisor session.", {
			agent: emptyAgent("spawn_agent"),
			dispatched: false,
			prompt: params.prompt,
		});
	}
	let prepared = coordinator.prepareChild({
		agentType,
		cwd: ctx.cwd,
		displayName,
		model: spawnModelMetadata(profile, ctx),
		parentId: params.parentId,
		permission: { narrowed: true, policy: "on-request" },
	});
	const abortController = new AbortController();
	let childSession: ChildAgentSession | undefined;
	if (createChildSession) {
		try {
			childSession = await createChildSession({
				activeToolCallId,
				agent: prepared,
				context,
				ctx,
				prompt: params.prompt,
				signal: abortController.signal,
			});
		} catch (error) {
			const runtimeError = {
				code: "runtime_spawn_failed",
				message: error instanceof Error ? error.message : String(error),
			};
			const failed = coordinator.commitFailedChild(prepared, runtimeError);
			if (failed.ok) publishCoordinatorSnapshot(store, failed.agent);
			return result(`spawn_agent failed to construct child session: ${runtimeError.message}`, {
				agent: failed.ok ? failed.agent : prepared,
				dispatched: false,
				prompt: params.prompt,
			});
		}
		if (childSession.transcript) prepared = { ...prepared, transcript: childSession.transcript };
	}
	const created = coordinator.commitRunningChild(
		prepared,
		ctx.sessionManager?.getSessionId() ?? store.getPersistenceTarget()?.sessionPath ?? "",
	);
	if (!created.ok) {
		await childSession?.dispose?.();
		return result(`spawn_agent failed: ${created.error}`, {
			agent: prepared,
			dispatched: false,
			prompt: params.prompt,
		});
	}
	store.publishLifecycleCoordinatorSnapshot(created.agent);
	const lifecycle: OwnedLifecycleCommandInput = { agent: created.agent, ownership: created.ownership };
	const runtime = { abortController, coordinator, lifecycle };
	ownerships.set(created.agent.id, runtime);

	if (createChildSession && childSession) {
		const restoreGeneration = store.getRestoreGeneration();
		const agent = startToolDispatch(
			store,
			dispatches,
			created.agent,
			() =>
				runAgentSession(
					store,
					createChildSession,
					created.agent,
					params.prompt,
					ctx,
					handles,
					childSession,
					runtime,
					restoreGeneration,
				),
			desktopNotifier,
			waitingDesktopNotifications,
			handles,
			runtime,
		);
		releaseOwnershipAfterDispatch(dispatches, ownerships, agent.id);
		return result(`Spawned ${agent.displayName} (${agent.id}) [type: ${agent.agentType}, context: ${context}]`, {
			agent,
			dispatched: true,
			prompt: params.prompt,
		});
	}

	throw new Error("spawn_agent child session runtime invariant violated");
}

function releaseOwnershipAfterDispatch(
	dispatches: ActiveAgentDispatches,
	ownerships: Map<string, OwnedAgentRuntime>,
	agentId: string,
): void {
	const dispatch = dispatches.get(agentId);
	if (dispatch) void dispatch.finally(() => ownerships.delete(agentId));
}

interface AttachSessionAgentRuntimeInput {
	createAttachedSession: AttachedSessionFactory | undefined;
	ctx: ExtensionContext;
	desktopNotifier: AgentDesktopNotifier;
	dispatches: ActiveAgentDispatches;
	handles?: BackgroundSessionHandles;
	params: AttachSessionAgentParams;
	ownerships: Map<string, OwnedAgentRuntime>;
	store: MultiAgentStore;
	waitingDesktopNotifications: WaitingDesktopNotificationHandles;
}

async function attachSessionAgent(input: AttachSessionAgentRuntimeInput): Promise<AgentToolResult<AgentToolDetails>> {
	const { ctx, params, store } = input;
	if (isChildAgentRuntime(ctx)) {
		return result(CHILD_ORCHESTRATION_UNAVAILABLE_MESSAGE, {
			agent: emptyAgent("attach_session_agent"),
			dispatched: false,
		});
	}
	const resolution = await resolveAttachSessionTarget(params, ctx);
	if (!resolution.ok) {
		return result(resolution.message, {
			agent: emptyAgent("attach_session_agent"),
			dispatched: false,
		});
	}
	const resolved = resolution.target;

	const prompt = params.prompt?.trim();
	if (prompt && !input.createAttachedSession) {
		return result(`Could not resume session ${resolved.sessionId}: no attached session runtime is configured.`, {
			agent: emptyAgent("attach_session_agent"),
			dispatched: false,
			prompt,
		});
	}

	const attached = spawnAttachedSessionAgent(store, params, resolved, ctx);
	if (!attached.ok) {
		return result(`Could not attach session ${resolved.sessionId}: ${attached.error}`, {
			agent: attached.parent ?? emptyAgent(params.parentId ?? "attach_session_agent"),
			dispatched: false,
		});
	}

	const dispatched = prompt
		? dispatchAttachedSessionAgent({
				createAttachedSession: input.createAttachedSession,
				ctx,
				desktopNotifier: input.desktopNotifier,
				dispatches: input.dispatches,
				handles: input.handles,
				ownerships: input.ownerships,
				prompt,
				store,
				target: attached.agent,
				waitingDesktopNotifications: input.waitingDesktopNotifications,
			})
		: undefined;
	if (dispatched) {
		return result(`Attached and resumed ${dispatched.displayName} (${dispatched.id})`, {
			agent: dispatched,
			dispatched: true,
			prompt,
		});
	}

	return result(`Attached ${attached.agent.displayName} (${attached.agent.id})`, {
		agent: attached.agent,
		dispatched: false,
	});
}

interface AttachSessionTarget {
	cwd: string;
	name?: string;
	path: string;
	sessionId: string;
}

type AttachSessionTargetResolution = { ok: true; target: AttachSessionTarget } | { ok: false; message: string };

interface AttachSessionDispatchInput {
	createAttachedSession: AttachedSessionFactory | undefined;
	ctx: ExtensionContext;
	desktopNotifier: AgentDesktopNotifier;
	dispatches: ActiveAgentDispatches;
	handles?: BackgroundSessionHandles;
	ownerships: Map<string, OwnedAgentRuntime>;
	prompt: string;
	store: MultiAgentStore;
	target: AgentSnapshot;
	waitingDesktopNotifications: WaitingDesktopNotificationHandles;
}

type AttachSessionResult = { ok: true; agent: AgentSnapshot } | { ok: false; error: string; parent?: AgentSnapshot };

function dispatchAttachedSessionAgent(input: AttachSessionDispatchInput): AgentSnapshot | undefined {
	const reservedRuntime = reserveAttachedRuntime(input);
	if (!reservedRuntime) return undefined;
	const target = reservedRuntime.lifecycle.agent;
	input.ownerships.set(target.id, reservedRuntime);
	input.store.publishLifecycleCoordinatorSnapshot(target);
	const createAttachedSession = input.createAttachedSession;
	if (!createAttachedSession) return undefined;
	const dispatched = startToolDispatch(
		input.store,
		input.dispatches,
		target,
		() => dispatchReservedAttachedChildSession(input, createAttachedSession, reservedRuntime),
		input.desktopNotifier,
		input.waitingDesktopNotifications,
		input.handles,
		reservedRuntime,
	);
	releaseOwnershipAfterDispatch(input.dispatches, input.ownerships, target.id);
	return dispatched;
}

function reserveAttachedRuntime(input: AttachSessionDispatchInput): OwnedAgentRuntime | undefined {
	const coordinator = createLifecycleCoordinator(input.store);
	if (!coordinator) return undefined;
	const persistence = input.store.getPersistenceTarget();
	if (!persistence) return undefined;
	const ownerSessionId = input.ctx.sessionManager?.getSessionId() ?? persistence.sessionPath;
	const acquired = coordinator.acquireAttachedRuntime(input.target, ownerSessionId);
	if (!acquired.ok) return undefined;
	return {
		abortController: new AbortController(),
		coordinator,
		lifecycle: { agent: acquired.agent, ownership: acquired.ownership },
	};
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

function dispatchReservedAttachedChildSession(
	input: AttachSessionDispatchInput,
	createAttachedSession: AttachedSessionFactory,
	reservedRuntime: OwnedAgentRuntime,
): Promise<AgentSnapshot> {
	const factory = (dispatchInput: ChildAgentDispatchInput) =>
		createAttachedSession({ ...dispatchInput, sessionPath: input.target.transcript?.path ?? "" });
	if (reservedRuntime.lifecycle.agent.lifecycle === "waiting_for_input") {
		return dispatchReservedAgentSession(
			input.store,
			factory,
			reservedRuntime,
			input.prompt,
			input.ctx,
			input.handles,
		);
	}
	return runAgentSession(
		input.store,
		factory,
		reservedRuntime.lifecycle.agent,
		input.prompt,
		input.ctx,
		input.handles,
		undefined,
		reservedRuntime,
	);
}

function spawnAttachedSessionAgent(
	store: MultiAgentStore,
	params: AttachSessionAgentParams,
	resolved: AttachSessionTarget,
	ctx: ExtensionContext,
): AttachSessionResult {
	const agentType = params.agentType?.trim() || "resumed-session";
	const displayName = params.displayName?.trim() || resolved.name || `Session ${resolved.sessionId}`;
	const profile = resolveConfiguredAgentProfile(agentType, ctx);
	const permission = buildAttachedSessionPermission(store, params.parentId);
	const parent = params.parentId ? store.getAgent(params.parentId) : undefined;
	const coordinator = createLifecycleCoordinator(store);
	if (!coordinator) return { ok: false, error: "lifecycle_coordinator_unavailable" };
	const attached = coordinator.createAttachment({
		account: parent?.account,
		agentType,
		cwd: resolved.cwd || ctx.cwd,
		displayName,
		model: readStoredSessionModel(ctx.controlDbPath, resolved.path) ?? profile?.modelMetadata ?? parent?.model,
		parentId: params.parentId,
		permission,
		transcript: { path: resolved.path, sessionId: resolved.sessionId },
	});
	if (!attached.ok) {
		return { ok: false, error: attached.error, parent };
	}
	store.publishLifecycleCoordinatorSnapshot(attached.agent);
	return attached;
}

function buildAttachedSessionPermission(
	store: MultiAgentStore,
	parentId: string | undefined,
): AgentSnapshot["permission"] {
	if (!parentId) {
		return { narrowed: true, policy: "on-request" };
	}
	const parent = store.getAgent(parentId);
	return { inheritedFrom: parentId, narrowed: true, policy: parent?.permission.policy ?? "on-request" };
}

async function resolveAttachSessionTarget(
	params: AttachSessionAgentParams,
	ctx: ExtensionContext,
): Promise<AttachSessionTargetResolution> {
	const path = params.path?.trim();
	const sessionId = params.sessionId?.trim();
	const name = params.name?.trim();
	if (countAttachSessionSelectors({ name, path, sessionId }) !== 1) {
		return { ok: false, message: "Could not attach session: provide exactly one of path, sessionId, or name." };
	}
	if (path) {
		const restoredPath = ctx.controlDbPath ? restoreArchivedSession(ctx.controlDbPath, path) : path;
		const session = SessionManager.open(restoredPath, ctx.sessionManager?.getSessionDir());
		const sessionPath = session.getSessionFile() ?? restoredPath;
		const metadata = ctx.controlDbPath ? readSessionMetadata(ctx.controlDbPath, sessionPath) : undefined;
		return {
			ok: true,
			target: {
				cwd: session.getCwd(),
				name: metadata?.name || metadata?.subagentName,
				path: sessionPath,
				sessionId: session.getSessionId(),
			},
		};
	}
	const match = await findAttachSessionMatch(ctx, { name, sessionId });
	if (match.status === "ambiguous") {
		return { ok: false, message: `Could not attach session: ${match.selector} matches multiple sessions.` };
	}
	if (match.status === "not_found") {
		return { ok: false, message: "Could not attach session: session not found." };
	}
	return {
		ok: true,
		target: {
			cwd: match.session.cwd,
			name: match.session.name,
			path: match.session.path,
			sessionId: match.session.id,
		},
	};
}

function countAttachSessionSelectors(target: { name?: string; path?: string; sessionId?: string }): number {
	const selectors = [target.name, target.path, target.sessionId];
	return selectors.filter((value) => value !== undefined && value !== "").length;
}

type AttachSessionMatchResult =
	| { status: "found"; session: AttachSessionInfo }
	| { status: "ambiguous"; selector: string }
	| { status: "not_found" };

async function findAttachSessionMatch(
	ctx: ExtensionContext,
	target: { name?: string; sessionId?: string },
): Promise<AttachSessionMatchResult> {
	const sessionDir = ctx.sessionManager?.getSessionDir();
	if (target.sessionId) {
		return findMatchingSession(await findAttachSessionsById(target.sessionId, sessionDir, ctx.controlDbPath), target);
	}
	const localSessions = await SessionManager.list(ctx.cwd, sessionDir, undefined, ctx.controlDbPath);
	const allSessions = await SessionManager.listAll(sessionDir, undefined, ctx.controlDbPath);
	return findMatchingSession(dedupeSessionsByPath([...localSessions, ...allSessions]), target);
}

function dedupeSessionsByPath(sessions: SessionInfo[]): SessionInfo[] {
	const deduped = new Map<string, SessionInfo>();
	for (const session of sessions) {
		deduped.set(session.path, session);
	}
	return [...deduped.values()];
}

function findMatchingSession(
	sessions: AttachSessionInfo[],
	target: { name?: string; sessionId?: string },
): AttachSessionMatchResult {
	const sessionId = target.sessionId;
	if (sessionId) {
		const exactMatches = sessions.filter((session) => session.id === sessionId);
		if (exactMatches.length > 1) {
			return { status: "ambiguous", selector: sessionId };
		}
		if (exactMatches[0]) {
			return { status: "found", session: exactMatches[0] };
		}
		const prefixMatches = sessions.filter((session) => session.id.startsWith(sessionId));
		if (prefixMatches.length > 1) {
			return { status: "ambiguous", selector: sessionId };
		}
		return prefixMatches[0] ? { status: "found", session: prefixMatches[0] } : { status: "not_found" };
	}
	const nameMatches = sessions.filter((session) => session.name === target.name);
	if (nameMatches.length > 1) {
		return { status: "ambiguous", selector: target.name ?? "name" };
	}
	return nameMatches[0] ? { status: "found", session: nameMatches[0] } : { status: "not_found" };
}

async function dispatchReservedAgentSession(
	store: MultiAgentStore,
	createChildSession: ChildAgentSessionFactory,
	reservedRuntime: OwnedAgentRuntime,
	prompt: string,
	ctx: ExtensionContext,
	handles?: BackgroundSessionHandles,
): Promise<AgentSnapshot> {
	const { coordinator, lifecycle } = reservedRuntime;
	const restoreGeneration = store.getRestoreGeneration();
	let childSession: ChildAgentSession;
	try {
		childSession = await createChildSession({
			agent: lifecycle.agent,
			context: "fresh",
			ctx,
			prompt,
			signal: reservedRuntime.abortController.signal,
		});
	} catch (error) {
		const runtimeError = {
			code: "runtime_spawn_failed",
			message: error instanceof Error ? error.message : String(error),
		};
		const failed = coordinator.finalizeChild({
			agent: lifecycle.agent,
			error: runtimeError,
			ownership: lifecycle.ownership,
			terminalLifecycle: "failed",
		});
		if (!failed.ok) return lifecycle.agent;
		publishCoordinatorSnapshot(store, failed.agent);
		return failed.agent;
	}
	if (store.getRestoreGeneration() !== restoreGeneration) {
		childSession.abort?.();
		await childSession.dispose?.();
		return store.getAgent(lifecycle.agent.id) ?? lifecycle.agent;
	}
	const running = coordinator.confirmChildRuntime(lifecycle);
	if (!running.ok) {
		childSession.abort?.();
		await childSession.dispose?.();
		return lifecycle.agent;
	}
	store.publishLifecycleCoordinatorSnapshot(running.agent);
	return runAgentSession(
		store,
		createChildSession,
		running.agent,
		prompt,
		ctx,
		handles,
		childSession,
		{
			...reservedRuntime,
			lifecycle: { agent: running.agent, ownership: reservedRuntime.lifecycle.ownership },
		},
		restoreGeneration,
	);
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

export type WaitNotificationsWake =
	| { kind: "agent"; agent: AgentSnapshot }
	| { kind: "cancelled" }
	| { kind: "coordination"; prompt?: string }
	| { kind: "error"; error: unknown }
	| { kind: "none" }
	| { kind: "timeout" }
	| { kind: "unavailable"; message: string }
	| { kind: "wake_up"; wakeUp: WaitAgentsWakeUp };

type RuntimeCoordinationRecipient = {
	address: RuntimeMailboxAddress;
	controlDbPath: string;
};

class WaitAgentsWakeWatcher {
	private readonly activeAgents: AgentSnapshot[];
	private readonly deadline: number | undefined;
	private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly controlDbPath: string;
	private readonly recipient: RuntimeCoordinationRecipient | undefined;
	private readonly sessionPath: string;
	private readonly signal: AbortSignal | undefined;
	private readonly store: MultiAgentStore;
	private readonly waitWakeListeners: MultiAgentRuntimeHandles["waitWakeListeners"];
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private resolve: ((wake: WaitNotificationsWake) => void) | undefined;
	private settled = false;
	private unsubscribeAgentTransitions = () => {};
	private unsubscribeWakeUp = () => {};

	constructor(
		store: MultiAgentStore,
		activeAgents: AgentSnapshot[],
		controlDbPath: string,
		sessionPath: string,
		signal: AbortSignal | undefined,
		recipient: RuntimeCoordinationRecipient | undefined,
		runtimeHandles: MultiAgentRuntimeHandles,
	) {
		this.activeAgents = activeAgents;
		this.deadline =
			runtimeHandles.latestModelRequestStartedAt === undefined
				? undefined
				: runtimeHandles.latestModelRequestStartedAt + WAIT_AGENT_SLICE_MS;
		this.controlDbPath = controlDbPath;
		this.sessionPath = sessionPath;
		this.recipient = recipient;
		this.signal = signal;
		this.store = store;
		this.waitWakeListeners = runtimeHandles.waitWakeListeners;
	}

	wait(): Promise<WaitNotificationsWake> {
		if (this.signal?.aborted) {
			return Promise.resolve({ kind: "cancelled" });
		}
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.start();
		});
	}

	private start(): void {
		const trackedAgentIds = new Set(this.activeAgents.map((agent) => agent.id));
		if (trackedAgentIds.size === 0) {
			this.checkCoordination();
			if (!this.settled) this.finish({ kind: "none" });
			return;
		}
		const readTrackedTerminal = (): AgentSnapshot | undefined => {
			const agents = readMultiAgentAgents(this.controlDbPath, this.sessionPath, [...trackedAgentIds]);
			return agents.find((agent) => !isActiveLifecycle(agent.lifecycle));
		};
		this.unsubscribeAgentTransitions = this.store.subscribeAgentTransitions(() => {
			const terminal = readTrackedTerminal();
			if (terminal) this.finish({ agent: terminal, kind: "agent" });
		});
		const onWakeUp = (wakeUp: WaitAgentsWakeUp) => {
			if (wakeUp.agentId && !trackedAgentIds.has(wakeUp.agentId)) return;
			const terminal = readTrackedTerminal();
			if (terminal) {
				this.finish({ agent: terminal, kind: "agent" });
				return;
			}
			if (wakeUp.kind === "coordination") {
				this.finish({ kind: "coordination", prompt: wakeUp.coordinationPrompt });
				return;
			}
			this.finish({ kind: "wake_up", wakeUp });
		};
		this.waitWakeListeners.add(onWakeUp);
		this.unsubscribeWakeUp = () => this.waitWakeListeners.delete(onWakeUp);
		this.signal?.addEventListener("abort", this.onAbort, { once: true });
		this.startRuntimeCoordinationWatch(readTrackedTerminal);
		this.reconcileDeadDetachedRuntimes();

		const terminalAgent = readTrackedTerminal();
		if (terminalAgent) {
			this.finish({ agent: terminalAgent, kind: "agent" });
			return;
		}
		this.checkCoordination();
		this.startDeadlineTimer(readTrackedTerminal);
	}

	private startDeadlineTimer(readTrackedTerminal: () => AgentSnapshot | undefined): void {
		if (this.settled || this.deadline === undefined) return;
		const remainingMs = this.deadline - Date.now();
		if (remainingMs <= 0) {
			this.finish({ kind: "timeout" });
			return;
		}
		this.deadlineTimer = setTimeout(
			this.finishOnError(() => {
				const terminal = readTrackedTerminal();
				if (terminal) {
					this.finish({ agent: terminal, kind: "agent" });
					return;
				}
				this.checkCoordination();
				this.finish({ kind: "timeout" });
			}),
			remainingMs,
		);
	}

	private reconcileDeadDetachedRuntimes(): void {
		const nowIso = new Date().toISOString();
		const artifactRoot = artifactRootForStore(this.store);
		if (LifecycleCoordinator.reconcileDeadDetachedRuntimes(this.controlDbPath, nowIso, artifactRoot) === 0) return;
		deliverTerminalOutboxProjections({
			artifactRoot,
			claimId: randomUUID(),
			controlDbPath: this.controlDbPath,
			now: () => nowIso,
			store: this.store,
		});
	}

	private startRuntimeCoordinationWatch(readTrackedTerminal: () => AgentSnapshot | undefined): void {
		this.pollTimer = setInterval(
			this.finishOnError(() => {
				this.reconcileDeadDetachedRuntimes();
				const terminal = readTrackedTerminal();
				if (terminal) {
					this.finish({ agent: terminal, kind: "agent" });
					return;
				}
				this.checkCoordination();
				if (this.deadline !== undefined && Date.now() >= this.deadline) this.finish({ kind: "timeout" });
			}),
			RUNTIME_COORDINATION_POLL_INTERVAL_MS,
		);
	}

	/** Timer callbacks settle the wait with an error wake instead of throwing an uncaught exception. */
	private finishOnError(tick: () => void): () => void {
		return () => {
			try {
				tick();
			} catch (error) {
				this.finish({ error, kind: "error" });
			}
		};
	}

	private readonly onAbort = () => {
		this.finish({ kind: "cancelled" });
	};

	private readonly checkCoordination = () => {
		if (!this.recipient) return;
		try {
			if (hasPendingRuntimeCoordinationMessage(this.recipient.controlDbPath, this.recipient.address)) {
				this.finish({ kind: "coordination" });
			}
		} catch (error) {
			this.finish({ error, kind: "error" });
		}
	};

	private finish(wake: WaitNotificationsWake): void {
		if (this.settled) return;
		this.settled = true;
		this.cleanup();
		this.resolve?.(wake);
		this.resolve = undefined;
	}

	private cleanup(): void {
		if (this.deadlineTimer !== undefined) {
			clearTimeout(this.deadlineTimer);
			this.deadlineTimer = undefined;
		}
		this.unsubscribeAgentTransitions();
		this.unsubscribeWakeUp();
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
		this.signal?.removeEventListener("abort", this.onAbort);
	}
}

async function waitAgents(
	store: MultiAgentStore,
	runtimeHandles: MultiAgentRuntimeHandles,
	signal: AbortSignal | undefined,
	ctx?: ExtensionContext,
): Promise<AgentToolResult<WaitAgentsToolDetails>> {
	const wake = await waitNotifications(store, runtimeHandles, signal, ctx);
	return consumeNotifications(store, wake, ctx);
}

export async function waitNotifications(
	store: MultiAgentStore,
	runtimeHandles = createMultiAgentRuntimeHandles(),
	signal?: AbortSignal,
	ctx?: ExtensionContext,
): Promise<WaitNotificationsWake> {
	if (ctx && isChildAgentRuntime(ctx)) {
		return { kind: "unavailable", message: CHILD_ORCHESTRATION_UNAVAILABLE_MESSAGE };
	}
	if (ctx) mirrorPendingLifecycleRuntimeMailboxMessages(store, ctx);
	const persistence = store.getPersistenceTarget();
	if (!persistence) {
		return { kind: "unavailable", message: "wait_agent requires a persisted supervisor session." };
	}
	const pending = listPendingTerminalNotifications(store, persistence.controlDbPath, persistence.sessionPath);
	if (pending.length > 0) return { agent: pending[0].agent, kind: "agent" };
	return waitForAgentOrCoordination(
		store,
		persistence.controlDbPath,
		persistence.sessionPath,
		signal,
		runtimeCoordinationRecipient(ctx),
		runtimeHandles,
	);
}

export function consumeNotifications(
	store: MultiAgentStore,
	wake: WaitNotificationsWake,
	ctx?: ExtensionContext,
): AgentToolResult<WaitAgentsToolDetails> {
	switch (wake.kind) {
		case "cancelled":
			return result("Wait cancelled.", {});
		case "coordination": {
			if (wake.prompt) return result(wake.prompt, {});
			const coordination = takePendingWaitCoordination(runtimeCoordinationRecipient(ctx));
			return result(coordination?.prompt || "Coordination input changed before delivery.", {
				runtimeMailboxDelivery: coordination?.runtimeMailboxDelivery,
			});
		}
		case "error": {
			const message = wake.error instanceof Error ? wake.error.message : String(wake.error);
			return result(`Wait failed: ${message}`, {});
		}
		case "none":
			return emptyResult();
		case "timeout":
			return result(
				"Wait slice timed out: agents are still running. No agents were cancelled. You can wait again after the next model request.",
				{ timedOut: true as const },
			);
		case "unavailable":
			return result(wake.message, {});
		case "wake_up": {
			const agent = wake.wakeUp.agentId ? store.getAgent(wake.wakeUp.agentId) : undefined;
			const text = agent ? `Woken after steering ${agent.displayName}.` : "Woken after supervisor steering.";
			return result(text, { wakeUp: wake.wakeUp });
		}
	}
	const persistence = store.getPersistenceTarget();
	if (persistence) {
		const pending = consumePendingTerminalNotifications(store, persistence.controlDbPath, persistence.sessionPath);
		if (pending) return pending;
	}
	return result(formatAgentStatus(wake.agent), { agent: wake.agent });
}

function runtimeCoordinationRecipient(ctx: ExtensionContext | undefined): RuntimeCoordinationRecipient | undefined {
	if (!ctx?.controlDbPath) return undefined;
	const address = resolveOwnMainRuntimeCoordinationRecipient(ctx.controlDbPath);
	if (!address) return undefined;
	return { address, controlDbPath: ctx.controlDbPath };
}

function takePendingWaitCoordination(
	recipient: RuntimeCoordinationRecipient | undefined,
): { prompt: string; runtimeMailboxDelivery?: RuntimeMailboxToolDelivery } | undefined {
	if (!recipient) return undefined;
	const mailboxMessages = takeRuntimeMailboxMessagesForDelivery(
		recipient.controlDbPath,
		recipient.address,
		isRuntimeCoordinationMailboxMessage,
		Number.MAX_SAFE_INTEGER,
	);
	try {
		const channelMessages = takePendingWaitSharedChannelMessages(recipient);
		const sections = [
			...mailboxMessages.map((message) => formatRuntimeMailboxPrompt(message, recipient.address.sessionId)),
			...(channelMessages.length > 0
				? [formatSharedChannelPrompt(channelMessages, recipient.address.sessionId)]
				: []),
		];
		if (sections.length === 0) return undefined;
		return {
			prompt: sections.join("\n\n"),
			runtimeMailboxDelivery:
				mailboxMessages.length > 0
					? {
							controlDbPath: recipient.controlDbPath,
							messages: mailboxMessages.map(({ id, storeRef }) => ({ id, storeRef })),
						}
					: undefined,
		};
	} catch (error) {
		for (const message of mailboxMessages) releaseRuntimeMailboxMessageClaim(recipient.controlDbPath, message.id);
		throw error;
	}
}

function takePendingWaitSharedChannelMessages(recipient: RuntimeCoordinationRecipient): SharedChannelMessage[] {
	if (recipient.address.agentId !== null) return [];
	const cursor = readSharedChannelCursor(recipient.controlDbPath, recipient.address);
	if (cursor === undefined) return [];
	const lastMessageId = readSharedChannelTail(recipient.controlDbPath);
	const messages = readSharedChannelMessagesThrough(recipient.controlDbPath, cursor, lastMessageId);
	advanceSharedChannelCursor(recipient.controlDbPath, recipient.address, lastMessageId);
	return messages.filter(
		(message) =>
			message.sender.agentId === null &&
			(message.originHost !== undefined || message.sender.sessionId !== recipient.address.sessionId),
	);
}

function readSharedChannelMessagesThrough(
	controlDbPath: string,
	cursor: number,
	lastMessageId: number,
): SharedChannelMessage[] {
	const messages: SharedChannelMessage[] = [];
	let pageCursor = cursor;
	while (pageCursor < lastMessageId) {
		const page = listSharedChannelMessagesAfter(controlDbPath, pageCursor, undefined, lastMessageId);
		const lastPageMessage = page.at(-1);
		if (!lastPageMessage) break;
		messages.push(...page);
		pageCursor = lastPageMessage.id;
	}
	return messages;
}

type PendingTerminalNotification = { agent: AgentSnapshot; message: AgentMailboxMessage };

function listPendingTerminalNotifications(
	store: MultiAgentStore,
	controlDbPath: string,
	sessionPath: string,
): PendingTerminalNotification[] {
	const firstNotificationByAgent = new Map<string, PendingLifecycleNotification>();
	for (const notification of store.listPendingLifecycleNotifications()) {
		if (notification.lifecycle === "waiting_for_input" || firstNotificationByAgent.has(notification.agentId))
			continue;
		firstNotificationByAgent.set(notification.agentId, notification);
	}
	if (firstNotificationByAgent.size === 0) return [];
	const persistedAgents = readMultiAgentAgents(controlDbPath, sessionPath, [...firstNotificationByAgent.keys()]);
	return persistedAgents.flatMap((agent) => {
		const notification = firstNotificationByAgent.get(agent.id);
		return notification && notification.lifecycle === agent.lifecycle
			? [{ agent, message: notification.message }]
			: [];
	});
}

function consumePendingTerminalNotifications(
	store: MultiAgentStore,
	controlDbPath: string,
	sessionPath: string,
): AgentToolResult<WaitAgentsToolDetails> | undefined {
	const pending = listPendingTerminalNotifications(store, controlDbPath, sessionPath);
	if (pending.length === 0) return undefined;

	for (const { message } of pending) store.markMailboxMessageDelivered(message.id);
	const agents = pending.map(({ agent }) => agent);
	const messages = pending.map(({ message }) => message);
	const text = pending.map(({ agent, message }) => message.body ?? formatAgentStatus(agent)).join("\n");
	return result(text, { agent: agents[0], agents, message: messages[0], messages });
}

async function waitForAgentOrCoordination(
	store: MultiAgentStore,
	controlDbPath: string,
	sessionPath: string,
	signal: AbortSignal | undefined,
	recipient: RuntimeCoordinationRecipient | undefined,
	runtimeHandles: MultiAgentRuntimeHandles,
): Promise<WaitNotificationsWake> {
	if (signal?.aborted) return Promise.resolve({ kind: "cancelled" });
	return new WaitAgentsWakeWatcher(
		store,
		readActiveMultiAgentAgents(controlDbPath, sessionPath),
		controlDbPath,
		sessionPath,
		signal,
		recipient,
		runtimeHandles,
	).wait();
}

function isInFlightLifecycle(lifecycle: AgentSnapshot["lifecycle"]): boolean {
	return isActiveLifecycle(lifecycle) && lifecycle !== "waiting_for_input";
}

function formatAgentStatus(agent: AgentSnapshot): string {
	const summary = agent.result?.summary?.trim();
	if (summary) {
		return `${agent.displayName} is ${agent.lifecycle}: ${summary}`;
	}

	const errorMessage = agent.error?.message?.trim();
	if (errorMessage) {
		return `${agent.displayName} is ${agent.lifecycle}: ${errorMessage}`;
	}

	return `${agent.displayName} is ${agent.lifecycle}.`;
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

function mirrorPendingLifecycleRuntimeMailboxMessages(store: MultiAgentStore, ctx: ExtensionContext): void {
	for (const { agentId, lifecycle, message } of store.listPendingLifecycleNotifications()) {
		if (store.getAgent(agentId)?.lifecycle !== lifecycle) continue;
		mirrorLifecycleRuntimeMailboxMessage(store, message, ctx);
	}
}

function mirrorLifecycleRuntimeMailboxMessage(
	store: MultiAgentStore,
	notification: AgentMailboxMessage,
	ctx: ExtensionContext,
): void {
	if (!ctx.controlDbPath) {
		return;
	}
	const storeRef = buildRuntimeMailboxStoreRef(store, notification, ctx);
	if (!storeRef) {
		console.error(
			`Runtime mailbox requires a store persisted to the control DB; dropped lifecycle notification ${notification.id}.`,
		);
		return;
	}
	const agent = store.getAgent(notification.fromAgentId);
	if (
		agent?.detached === true &&
		agent.suppressTerminalNotification !== true &&
		(agent.lifecycle === "completed" || agent.lifecycle === "failed" || agent.lifecycle === "aborted")
	) {
		return;
	}
	const recipient = resolveRuntimeRecipient(store, notification, ctx);
	if (!recipient) return;
	const currentSessionId = ctx.sessionManager.getSessionId();
	const senderSessionId = agent?.transcript?.sessionId ?? currentSessionId;
	enqueueRuntimeMailboxMessage(ctx.controlDbPath, {
		kind: notification.kind,
		recipient,
		sender: {
			agentId: notification.fromAgentId,
			sessionId: senderSessionId,
		},
		storeRef,
	});
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
