import { randomUUID } from "node:crypto";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import {
	type AgentToolResult,
	defineTool,
	type ExtensionAPI,
	type ExtensionFactory,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "../../../src/core/extensions/types.ts";
import {
	PERSISTENT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS,
	sendDesktopNotification,
	toDesktopNotificationHandle,
	type DesktopNotification,
	type DesktopNotificationHandle,
	type DesktopNotifier,
} from "../../../src/core/desktop-notification.ts";
import {
	LifecycleCoordinator,
	type OwnedLifecycleCommandInput,
} from "../../../src/core/lifecycle-coordinator.ts";
import { isProcessIdentityAlive, readProcessIdentity } from "../../../src/core/runtime-process.ts";
import {
	type AgentLifecycleState,
	type AgentMailboxMessage,
	type AgentResult,
	type AgentSnapshot,
	type ContactSupervisorInput,
	formatInactiveAgentSelectionMessage,
	isActiveLifecycle,
	type MailboxMessageCommandResult,
	MultiAgentStore,
	type SendMailboxMessageInput,
	type SteeringCheckpoint,
} from "../../../src/core/multi-agent-store.ts";
import { findExactModelReferenceMatch } from "../../../src/core/model-resolver.ts";
import {
	enqueueRuntimeMailboxMessage,
	hasPendingRuntimeCoordinationMessage,
	listRuntimeMailboxMessages,
	listSessionMetadata,
	readMultiAgentRuntimeOwnership,
	readMultiAgentState,
	readSessionMetadata,
	resolveOwnMainRuntimeCoordinationRecipient,
	type RuntimeMailboxAddress,
	type RuntimeMailboxMessage,
} from "../../../src/core/session-control-db.ts";
import { SessionManager, type SessionEntry, type SessionInfo } from "../../../src/core/session-manager.ts";
import type { CreateAgentSessionOptions } from "../../../src/core/sdk.ts";
import { SUPERVISOR_ONLY_TOOL_NAMES } from "../../../src/core/tool-capabilities.ts";
import { deliverTerminalOutboxProjections } from "../../../src/core/terminal-outbox-delivery.ts";

const MAX_GOAL_OBJECTIVE_CHARS = 4000;
const GOAL_EXTENSION_PATH = "<first-party:goal>";

const checkpointSchema = Type.Union([
	Type.Literal("next_model_call"),
	Type.Literal("after_tool_result"),
	Type.Literal("when_waiting"),
]);

const fileReferenceSchema = Type.Object({
	path: Type.String(),
	label: Type.Optional(Type.String()),
});

const spawnAgentSchema = Type.Object({
	agentType: Type.Optional(Type.String()),
	displayName: Type.Optional(Type.String()),
	parentId: Type.Optional(Type.String()),
	prompt: Type.String(),
});

const listAgentsSchema = Type.Object({
	activeOnly: Type.Optional(Type.Boolean()),
	parentId: Type.Optional(Type.String()),
});

const attachSessionAgentSchema = Type.Object({
	agentType: Type.Optional(Type.String()),
	displayName: Type.Optional(Type.String()),
	name: Type.Optional(Type.String()),
	parentId: Type.Optional(Type.String()),
	path: Type.Optional(Type.String()),
	prompt: Type.Optional(Type.String()),
	sessionId: Type.Optional(Type.String()),
});

const waitAgentsSchema = Type.Object({}, { additionalProperties: false });

const cancelAgentSchema = Type.Object({
	agentId: Type.String(),
	reason: Type.Optional(Type.String()),
});

const steerAgentSchema = Type.Object({
	agentId: Type.String(),
	fileRefs: Type.Optional(Type.Array(fileReferenceSchema)),
	message: Type.String(),
	fromAgentId: Type.Optional(Type.String()),
	targetCheckpoint: Type.Optional(checkpointSchema),
});

const contactSupervisorSchema = Type.Object({
	agentId: Type.String(),
	fileRefs: Type.Optional(Type.Array(fileReferenceSchema)),
	message: Type.String(),
	threadId: Type.Optional(Type.String()),
});

const agentViewerSchema = Type.Object({
	agentId: Type.String(),
	sessionId: Type.Optional(Type.String()),
	storeSessionId: Type.Optional(Type.String()),
});

const sendAgentMessageSchema = Type.Object({
	fileRefs: Type.Optional(Type.Array(fileReferenceSchema)),
	message: Type.String(),
	threadId: Type.Optional(Type.String()),
	toAgentId: Type.String(),
	toSessionId: Type.Optional(Type.String()),
});

type SpawnAgentParams = Static<typeof spawnAgentSchema>;
type AttachSessionAgentParams = Static<typeof attachSessionAgentSchema>;
type ListAgentsParams = Static<typeof listAgentsSchema>;
type AgentViewerParams = Static<typeof agentViewerSchema>;
type CancelAgentParams = Static<typeof cancelAgentSchema>;
type SteerAgentParams = Static<typeof steerAgentSchema>;
type ContactSupervisorParams = Static<typeof contactSupervisorSchema>;
type SendAgentMessageParams = Static<typeof sendAgentMessageSchema>;

type ChildSessionModel = CreateAgentSessionOptions["model"];

type ResolvedAgentProfile = {
	model?: ChildSessionModel;
	modelMetadata?: AgentSnapshot["model"];
	thinkingLevel?: ThinkingLevel;
};

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);
const MAIN_THREAD_AGENT_ID = "main";
const CANCELLATION_SETTLEMENT_TIMEOUT_MS = 5_000;
const RUNTIME_PROCESS_IDENTITY = readProcessIdentity(process.pid);
const CRASH_RECOVERY_PROMPT =
	"Continue the conversation from where it left off without asking the user any further questions. Resume directly from the saved session context.";
const MESSAGE_CONTENT_LIMIT = 2000;
const RUNTIME_COORDINATION_POLL_INTERVAL_MS = 3_000;
const CHILD_ORCHESTRATION_UNAVAILABLE_MESSAGE = "Agent orchestration is unavailable from child agent runtimes.";

export type AgentDesktopNotification = DesktopNotification;

export type AgentDesktopNotifier = DesktopNotifier;

export interface MultiAgentExtensionOptions {
	createAttachedSession?: AttachedSessionFactory;
	createChildSession?: ChildAgentSessionFactory;
	desktopNotifier?: AgentDesktopNotifier;
	dispatcher?: ChildAgentDispatcher;
	runtimeHandles?: MultiAgentRuntimeHandles;
	selectAgentView?: (agentId: string) => boolean | undefined;
	onSessionMessageSent?: (input: { message: AgentMailboxMessage; toSessionId: string }) => void;
	store?: MultiAgentStore;
}

export interface ChildAgentDispatchInput {
	agent: AgentSnapshot;
	ctx: ExtensionContext;
	prompt: string;
	signal?: AbortSignal;
}

export interface ChildAgentDispatchResult {
	lifecycle: "completed" | "failed" | "aborted" | "waiting_for_input";
	error?: { message: string; code?: string };
	result?: AgentResult;
}

export type ChildAgentDispatcher = (input: ChildAgentDispatchInput) => Promise<ChildAgentDispatchResult>;

export interface ChildAgentSession {
	abort?(): void;
	dispose?(): void;
	drainRuntimeCoordination?(): Promise<void>;
	messages: AgentMessage[];
	prompt(text: string): Promise<void>;
	transcript?: AgentSnapshot["transcript"];
}

export type ChildAgentSessionFactory = (input: ChildAgentDispatchInput) => Promise<ChildAgentSession>;

const productionChildSessionFactoryMarker = Symbol("productionChildSessionFactory");

type ProductionChildAgentSessionFactory = ChildAgentSessionFactory & {
	[productionChildSessionFactoryMarker]: true;
};

type GoalObjectiveValidation =
	| { objective: string; ok: true }
	| { length: number; ok: false; reason: "empty" | "too_long" };

export interface AttachedSessionDispatchInput extends ChildAgentDispatchInput {
	sessionPath: string;
}

export type AttachedSessionFactory = (input: AttachedSessionDispatchInput) => Promise<ChildAgentSession>;

export interface ProductionChildAgentSessionFactoryOptions {
	agentDir?: string;
	createSession: (options: CreateAgentSessionOptions) => Promise<{ session: ChildAgentSession }>;
	createSessionManager: (
		cwd: string,
		sessionDir: string | undefined,
		options: { parentSession: string; isSubagent?: boolean; subagentName?: string },
	) => NonNullable<CreateAgentSessionOptions["sessionManager"]>;
	extensionFactories?: ExtensionFactory[] | (() => ExtensionFactory[]);
	multiAgentStore?: MultiAgentStore;
	sessionDir?: string;
}

export type HostrunMultiAgentRequestHandler = (
	request: { method: string; params: unknown },
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
) => Promise<unknown> | unknown;

interface MainThreadSnapshot extends Record<string, unknown> {
	displayName: "Main thread";
	id: "main";
	lifecycle: "current";
	selected: true;
}

interface AgentSelectionDetails extends Record<string, unknown> {
	agent: AgentSnapshot | MainThreadSnapshot;
}

interface LastMessageDetails extends Record<string, unknown> {
	content?: string;
	entryId: string;
	role: string;
	text?: string;
	truncated?: true;
}

interface AgentToolDetails extends Record<string, unknown> {
	agent: AgentSnapshot;
	descendants?: AgentSnapshot[];
	detached?: boolean;
	dispatched?: boolean;
	pendingMessages?: AgentMailboxMessage[];
	prompt?: string;
	reason?: string;
	terminal?: boolean;
}

interface AgentListToolDetails {
	agents: AgentSnapshot[];
	activeCount: number;
}

interface AgentSteerToolDetails {
	agent: AgentSnapshot;
	message: AgentMailboxMessage;
}

interface ContactSupervisorToolDetails {
	agent: AgentSnapshot;
	message: AgentMailboxMessage;
}

interface WaitAgentsToolDetails {
	agent?: AgentSnapshot;
	message?: AgentMailboxMessage;
}
interface AgentViewerToolDetails {
	agent?: AgentSnapshot;
	agentId?: string;
	children?: string[];
	commands?: AgentViewerCommand[];
	error?: "missing_control_db" | "not_found" | "session_mismatch" | "session_not_found";
	parentId?: string;
	sessionId?: string;
	status?: AgentViewerStatus;
	transcript?: AgentViewerTranscript;
}

interface AgentViewerStatus {
	agentId: string;
	lifecycle: AgentSnapshot["lifecycle"];
	revision: number;
	terminal: boolean;
}

interface AgentViewerTranscript {
	agentId: string;
	path?: string;
	sessionId: string;
}

interface AgentViewerCommand {
	agentId: string;
	command: "stop" | "steer";
	tool: "cancel_agent" | "steer_agent";
}

interface SendAgentMessageToolDetails {
	agent: AgentSnapshot;
	message: AgentMailboxMessage;
}

type BackgroundSessionHandles = Map<string, ChildAgentSession>;
type ActiveAgentDispatches = Map<string, Promise<AgentSnapshot>>;

interface OwnedAgentRuntime {
	abortController: AbortController;
	coordinator: LifecycleCoordinator;
	lifecycle: OwnedLifecycleCommandInput;
}

export interface MultiAgentRuntimeHandles {
	dispatches: ActiveAgentDispatches;
	ownerships: Map<string, OwnedAgentRuntime>;
	sessions: BackgroundSessionHandles;
}

export function createMultiAgentRuntimeHandles(): MultiAgentRuntimeHandles {
	return { dispatches: new Map(), ownerships: new Map(), sessions: new Map() };
}

interface WaitingDesktopNotificationRegistration {
	handle: DesktopNotificationHandle;
	unsubscribeTransition: () => void;
}

type WaitingDesktopNotificationHandles = Map<string, WaitingDesktopNotificationRegistration>;

interface BackgroundDispatchContext {
	createChildSession: ChildAgentSessionFactory | undefined;
	dispatcher: ChildAgentDispatcher | undefined;
	dispatches: ActiveAgentDispatches;
	handles: BackgroundSessionHandles;
	ownerships: Map<string, OwnedAgentRuntime>;
	store: MultiAgentStore;
}

function result<TDetails extends Record<string, unknown>>(text: string, details: TDetails): AgentToolResult<TDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

function emptyResult(): AgentToolResult<Record<string, never>> {
	return { content: [], details: {} };
}

function errorResult<TDetails extends Record<string, unknown>>(
	text: string,
	details: TDetails,
): AgentToolResult<TDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
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

function validateGoalObjective(prompt: string): GoalObjectiveValidation {
	const objective = prompt.trim();
	if (!objective) {
		return { length: 0, ok: false, reason: "empty" };
	}
	if (objective.length > MAX_GOAL_OBJECTIVE_CHARS) {
		return { length: objective.length, ok: false, reason: "too_long" };
	}
	return { objective, ok: true };
}

function isProductionChildSessionFactory(
	factory: ChildAgentSessionFactory | undefined,
): factory is ProductionChildAgentSessionFactory {
	return (factory as Partial<ProductionChildAgentSessionFactory> | undefined)?.[productionChildSessionFactoryMarker] === true;
}

function spawnPromptValidationMessage(validation: Exclude<GoalObjectiveValidation, { ok: true }>): string {
	return validation.reason === "empty"
		? "spawn_agent requires a non-empty prompt"
		: `spawn_agent prompt too long (${validation.length} > ${MAX_GOAL_OBJECTIVE_CHARS} chars)`;
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

	if (background.dispatcher) {
		const promise = trackAgentDispatch(
			background.store,
			background.dispatches,
			agent,
			runAgentDispatcher(background.store, background.dispatcher, agent, prompt, ctx, runtime),
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
		childSession?.dispose?.();
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
	ctx.ui.notify(`Background job ${agent.id} started. Use /jobs to inspect it or wait_agents to wait for any completion.`, "info");
}

function jobsCommand(store: MultiAgentStore, ctx: ExtensionCommandContext): void {
	const agents = store.listAgents().filter((agent) => agent.agentType === "background");
	if (agents.length === 0) {
		ctx.ui.notify("No background jobs.", "info");
		return;
	}

	ctx.ui.notify(agents.map((agent) => `${agent.id} ${formatAgentStatus(agent)}`).join("\n"), "info");
}

function resolveChildExtensionFactories(
	extensionFactories: ProductionChildAgentSessionFactoryOptions["extensionFactories"],
): ExtensionFactory[] | undefined {
	const factories = typeof extensionFactories === "function" ? extensionFactories() : extensionFactories;
	return factories?.filter(
		(factory) => (factory as ExtensionFactory & { extensionPath?: string }).extensionPath !== GOAL_EXTENSION_PATH,
	);
}

function getSessionTranscriptMetadata(
	sessionManager: NonNullable<CreateAgentSessionOptions["sessionManager"]>,
): AgentSnapshot["transcript"] {
	return {
		path: sessionManager.getSessionFile(),
		sessionId: sessionManager.getSessionId(),
	};
}

export function createProductionChildAgentSessionFactory(
	options: ProductionChildAgentSessionFactoryOptions,
): ChildAgentSessionFactory {
	const factory: ProductionChildAgentSessionFactory = async ({ agent, ctx, prompt }) => {
		const validation = validateGoalObjective(prompt);
		if (!validation.ok) {
			throw new Error(spawnPromptValidationMessage(validation));
		}
		const parentSessionFile = ctx.sessionManager.getSessionFile();
		const parentSession = parentSessionFile ?? ctx.sessionManager.getSessionId();
		const sessionDir = options.sessionDir ?? ctx.sessionManager.getSessionDir();
		const sessionManager = options.createSessionManager(agent.cwd, sessionDir, {
			parentSession,
			isSubagent: true,
			subagentName: agent.displayName,
		});
		const profile = resolveChildAgentProfile(agent, ctx);
		const sessionStartEvent = parentSessionFile
			? { type: "session_start" as const, reason: "fork" as const, previousSessionFile: parentSessionFile }
			: { type: "session_start" as const, reason: "fork" as const };
		const result = await options.createSession({
			agentDir: options.agentDir,
			cwd: agent.cwd,
			excludeTools: ["attach_session_agent", "spawn_agent", "wait_agents", ...SUPERVISOR_ONLY_TOOL_NAMES],
			extensionFactories: resolveChildExtensionFactories(options.extensionFactories),
			model: profile.model ?? ctx.model,
			modelRegistry: ctx.modelRegistry,
			multiAgentAgentId: agent.id,
			multiAgentParentSessionId: ctx.sessionManager.getSessionId(),
			multiAgentRequiresAgentId: true,
			multiAgentRuntimeRole: "child",
			multiAgentStore: options.multiAgentStore,
			sessionManager,
			sessionStartEvent,
			thinkingLevel: profile.thinkingLevel,
		});

		result.session.transcript = getSessionTranscriptMetadata(sessionManager);
		return result.session;
	};
	factory[productionChildSessionFactoryMarker] = true;
	return factory;
}

export function createProductionAttachedSessionFactory(
	options: Omit<ProductionChildAgentSessionFactoryOptions, "createSessionManager">,
): AttachedSessionFactory {
	return async ({ agent, ctx, sessionPath }) => {
		if (!sessionPath) {
			throw new Error("Cannot resume attached session without a session path");
		}
		const sessionDir = options.sessionDir ?? ctx.sessionManager.getSessionDir();
		const sessionManager = SessionManager.open(sessionPath, sessionDir, agent.cwd);
		sessionManager.setMetadataControlDbPath(ctx.controlDbPath);
		const profile = resolveChildAgentProfile(agent, ctx);
		const parentSessionFile = ctx.sessionManager.getSessionFile();
		const sessionStartEvent = parentSessionFile
			? { type: "session_start" as const, reason: "resume" as const, previousSessionFile: parentSessionFile }
			: { type: "session_start" as const, reason: "resume" as const };
		const result = await options.createSession({
			agentDir: options.agentDir,
			cwd: agent.cwd,
			excludeTools: ["attach_session_agent", "spawn_agent", "wait_agents", ...SUPERVISOR_ONLY_TOOL_NAMES],
			extensionFactories: resolveChildExtensionFactories(options.extensionFactories),
			model: profile.model ?? ctx.model,
			modelRegistry: ctx.modelRegistry,
			multiAgentAgentId: agent.id,
			multiAgentParentSessionId: ctx.sessionManager.getSessionId(),
			multiAgentRequiresAgentId: true,
			multiAgentRuntimeRole: "child",
			multiAgentStore: options.multiAgentStore,
			sessionManager,
			sessionStartEvent,
			thinkingLevel: profile.thinkingLevel,
		});

		result.session.transcript = getSessionTranscriptMetadata(sessionManager);
		return result.session;
	};
}

function resolveChildAgentProfile(agent: AgentSnapshot, ctx: ExtensionContext): ResolvedAgentProfile {
	const configuredModel = agent.model ? ctx.modelRegistry.find(agent.model.providerId, agent.model.modelId) : undefined;
	return {
		model: configuredModel,
		thinkingLevel: toThinkingLevel(agent.model?.thinkingLevel),
	};
}

function resolveConfiguredAgentProfile(agentType: string, ctx: ExtensionContext): ResolvedAgentProfile {
	const profile = ctx.settingsManager?.getAgentProfile(agentType);
	if (!profile) {
		return {};
	}

	const model = profile.model ? findExactModelReferenceMatch(profile.model, ctx.modelRegistry.getAll()) : undefined;
	return {
		model,
		modelMetadata: model ? { providerId: model.provider, modelId: model.id, thinkingLevel: profile.thinkingLevel } : undefined,
		thinkingLevel: profile.thinkingLevel,
	};
}

function toThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
	return value && THINKING_LEVELS.has(value as ThinkingLevel) ? (value as ThinkingLevel) : undefined;
}

export function createHostrunMultiAgentRequestHandler(
	options: MultiAgentExtensionOptions,
): HostrunMultiAgentRequestHandler {
	const store = resolveMultiAgentStore(options);
	const runtimeHandles = options.runtimeHandles ?? createMultiAgentRuntimeHandles();
	const activeDispatches = runtimeHandles.dispatches;
	const ownerships = runtimeHandles.ownerships;
	const backgroundSessions = runtimeHandles.sessions;
	const desktopNotifier = options.desktopNotifier ?? sendDesktopNotification;
	const waitingDesktopNotifications: WaitingDesktopNotificationHandles = new Map();
	const runtimeLifecycleMirror = createRuntimeLifecycleMirror(store);

	return async (request, ctx, signal) => {
		runtimeLifecycleMirror.bind(ctx);
		if (isChildAgentRuntime(ctx) && isSupervisorOnlyAgentRequest(request.method)) {
			throw new Error(CHILD_ORCHESTRATION_UNAVAILABLE_MESSAGE);
		}
		if (request.method === "agents.spawn") {
			const result = await spawnAgent(
				store,
				options.createChildSession,
				options.dispatcher,
				activeDispatches,
				ownerships,
				request.params as SpawnAgentParams,
				ctx,
				desktopNotifier,
				waitingDesktopNotifications,
				undefined,
				backgroundSessions,
			);
			return result.details;
		}

		if (request.method === "agents.wait") {
			assertNoWaitAgentsParams(request.params, "pi.agents.wait");
			await waitAgents(store, signal, ctx);
			return null;
		}

		if (request.method === "agents.attachSession") {
			const result = await attachSessionAgent({
				createAttachedSession: options.createAttachedSession,
				ctx,
				desktopNotifier,
				dispatcher: options.dispatcher,
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
			const params = request.params === undefined || request.params === null ? {} : (request.params as ListAgentsParams);
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
		return selectCurrentAgent(store);
	}
	if (rendered === false) {
		throw new Error(`Agent view selection failed: ${agentId}`);
	}

	if (agentId === MAIN_THREAD_AGENT_ID) {
		store.clearSelectedAgentView();
		return { agent: createMainThreadSnapshot() };
	}

	const result = store.selectActiveAgentTargetWithStatus(agentId);
	if (result.ok) {
		return { agent: result.agent };
	}
	if (result.error === "inactive") {
		throw new Error(formatInactiveAgentSelectionMessage(result.agent));
	}
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
	return (
		ctx.multiAgentAgentId !== undefined ||
		ctx.multiAgentRequiresAgentId === true ||
		ctx.sessionManager?.isSubagentSession?.() === true
	);
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

function createLifecycleCoordinator(store: MultiAgentStore): LifecycleCoordinator | undefined {
	const persistence = store.getPersistenceTarget();
	if (!persistence) return undefined;
	return new LifecycleCoordinator({
		controlDbPath: persistence.controlDbPath,
		createAgentId: () => store.allocateAgentIdForLifecycleCoordinator(),
		now: () => new Date().toISOString(),
		processIdentity: RUNTIME_PROCESS_IDENTITY,
		sessionPath: persistence.sessionPath,
	});
}

async function spawnAgent(
	store: MultiAgentStore,
	createChildSession: ChildAgentSessionFactory | undefined,
	dispatcher: ChildAgentDispatcher | undefined,
	dispatches: ActiveAgentDispatches,
	ownerships: Map<string, OwnedAgentRuntime>,
	params: SpawnAgentParams,
	ctx: ExtensionContext,
	desktopNotifier: AgentDesktopNotifier,
	waitingDesktopNotifications: WaitingDesktopNotificationHandles,
	pi?: ExtensionAPI,
	handles?: BackgroundSessionHandles,
): Promise<AgentToolResult<AgentToolDetails>> {
	if (isChildAgentRuntime(ctx)) {
		return errorResult(CHILD_ORCHESTRATION_UNAVAILABLE_MESSAGE, {
			agent: emptyAgent("spawn_agent"),
			dispatched: false,
			prompt: params.prompt,
		});
	}
	if (isProductionChildSessionFactory(createChildSession)) {
		const validation = validateGoalObjective(params.prompt);
		if (!validation.ok) {
			return errorResult(spawnPromptValidationMessage(validation), {
				agent: emptyAgent("spawn_agent"),
				dispatched: false,
				prompt: params.prompt,
			});
		}
	}
	if (!createChildSession && !dispatcher) {
		return errorResult("spawn_agent is unavailable: no executable runtime is configured.", {
			agent: emptyAgent("spawn_agent"),
			dispatched: false,
			prompt: params.prompt,
		});
	}
	const displayName = params.displayName?.trim() || params.agentType?.trim() || "Agent";
	const agentType = params.agentType?.trim() || "default";
	const profile = resolveConfiguredAgentProfile(agentType, ctx);
	const coordinator = createLifecycleCoordinator(store);
	if (!coordinator) {
		return errorResult("spawn_agent requires a persisted supervisor session.", {
			agent: emptyAgent("spawn_agent"),
			dispatched: false,
			prompt: params.prompt,
		});
	}
	let prepared = coordinator.prepareChild({
		agentType,
		cwd: ctx.cwd,
		displayName,
		model: profile.modelMetadata,
		parentId: params.parentId,
		permission: { narrowed: true, policy: "on-request" },
	});
	const abortController = new AbortController();
	let childSession: ChildAgentSession | undefined;
	if (createChildSession) {
		try {
			childSession = await createChildSession({
				agent: prepared,
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
			return errorResult(`spawn_agent failed to construct child session: ${runtimeError.message}`, {
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
		childSession?.dispose?.();
		return errorResult(`spawn_agent failed: ${created.error}`, {
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
		return result(`Spawned ${agent.displayName} (${agent.id})`, {
			agent,
			dispatched: true,
			prompt: params.prompt,
		});
	}

	if (dispatcher) {
		const agent = startToolDispatch(
			store,
			dispatches,
			created.agent,
			() => runAgentDispatcher(store, dispatcher, created.agent, params.prompt, ctx, runtime),
			desktopNotifier,
			waitingDesktopNotifications,
			undefined,
			runtime,
		);
		releaseOwnershipAfterDispatch(dispatches, ownerships, agent.id);
		return result(`Spawned ${agent.displayName} (${agent.id})`, {
			agent,
			dispatched: true,
			prompt: params.prompt,
		});
	}

	throw new Error("spawn_agent executable runtime invariant violated");
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
	dispatcher: ChildAgentDispatcher | undefined;
	dispatches: ActiveAgentDispatches;
	handles?: BackgroundSessionHandles;
	params: AttachSessionAgentParams;
	ownerships: Map<string, OwnedAgentRuntime>;
	pi?: ExtensionAPI;
	store: MultiAgentStore;
	waitingDesktopNotifications: WaitingDesktopNotificationHandles;
}

async function attachSessionAgent(input: AttachSessionAgentRuntimeInput): Promise<AgentToolResult<AgentToolDetails>> {
	const { ctx, params, store } = input;
	if (isChildAgentRuntime(ctx)) {
		return errorResult(CHILD_ORCHESTRATION_UNAVAILABLE_MESSAGE, {
			agent: emptyAgent("attach_session_agent"),
			dispatched: false,
		});
	}
	const resolution = await resolveAttachSessionTarget(params, ctx);
	if (!resolution.ok) {
		return errorResult(resolution.message, {
			agent: emptyAgent("attach_session_agent"),
			dispatched: false,
		});
	}
	const resolved = resolution.target;

	const prompt = params.prompt?.trim();
	if (prompt && !input.createAttachedSession && !input.dispatcher) {
		return errorResult(`Could not resume session ${resolved.sessionId}: no attached session runtime is configured.`, {
			agent: emptyAgent("attach_session_agent"),
			dispatched: false,
			prompt,
		});
	}

	const attached = spawnAttachedSessionAgent(store, params, resolved, ctx);
	if (!attached.ok) {
		return errorResult(`Could not attach session ${resolved.sessionId}: ${attached.error}`, {
			agent: attached.parent ?? emptyAgent(params.parentId ?? "attach_session_agent"),
			dispatched: false,
		});
	}

	const dispatched = prompt
		? dispatchAttachedSessionAgent({
				createAttachedSession: input.createAttachedSession,
				ctx,
				desktopNotifier: input.desktopNotifier,
				dispatcher: input.dispatcher,
				dispatches: input.dispatches,
				handles: input.handles,
				pi: input.pi,
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

type AttachSessionTargetResolution =
	| { ok: true; target: AttachSessionTarget }
	| { ok: false; message: string };

interface AttachSessionDispatchInput {
	createAttachedSession: AttachedSessionFactory | undefined;
	ctx: ExtensionContext;
	desktopNotifier: AgentDesktopNotifier;
	dispatcher: ChildAgentDispatcher | undefined;
	dispatches: ActiveAgentDispatches;
	handles?: BackgroundSessionHandles;
	pi?: ExtensionAPI;
	ownerships: Map<string, OwnedAgentRuntime>;
	prompt: string;
	store: MultiAgentStore;
	target: AgentSnapshot;
	waitingDesktopNotifications: WaitingDesktopNotificationHandles;
}

type AttachSessionResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: string; parent?: AgentSnapshot };

function dispatchAttachedSessionAgent(input: AttachSessionDispatchInput): AgentSnapshot | undefined {
	const reservedRuntime = reserveAttachedRuntime(input);
	if (!reservedRuntime) return undefined;
	const target = reservedRuntime.lifecycle.agent;
	input.ownerships.set(target.id, reservedRuntime);
	input.store.publishLifecycleCoordinatorSnapshot(target);
	const createAttachedSession = input.createAttachedSession;
	if (createAttachedSession) {
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
	const dispatcher = input.dispatcher;
	if (!dispatcher) {
		return undefined;
	}
	const dispatched = startToolDispatch(
		input.store,
		input.dispatches,
		target,
		() => dispatchReservedAttachedAgent(input, dispatcher, reservedRuntime),
		input.desktopNotifier,
		input.waitingDesktopNotifications,
		undefined,
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
	if (input.ctx.multiAgentAgentId) {
		return;
	}
	for (const agent of orderRecoveryAgents(input.store.listActiveAgents())) {
		recoverAgent(input, agent);
	}
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
	const recovered = coordinator.recoverDeadChild({ agent, ownerSessionId, ownership: deadOwnership });
	if (recovered.ok) publishCoordinatorSnapshot(input.store, recovered.agent);
}

function hasLiveAgentOwner(
	input: Omit<AttachSessionDispatchInput, "prompt" | "target">,
	agent: AgentSnapshot,
): boolean {
	const persistence = input.store.getPersistenceTarget();
	if (!persistence) return false;
	const ownership = readMultiAgentRuntimeOwnership(persistence.controlDbPath, persistence.sessionPath, agent.id);
	return ownership?.processIdentity ? isProcessIdentityAlive(ownership.processIdentity) : false;
}

function dispatchReservedAttachedChildSession(
	input: AttachSessionDispatchInput,
	createAttachedSession: AttachedSessionFactory,
	reservedRuntime: OwnedAgentRuntime,
): Promise<AgentSnapshot> {
	const factory = (dispatchInput: ChildAgentDispatchInput) =>
		createAttachedSession({ ...dispatchInput, sessionPath: input.target.transcript?.path ?? "" });
	if (reservedRuntime.lifecycle.agent.lifecycle === "running") {
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
	return dispatchReservedAgentSession(input.store, factory, reservedRuntime, input.prompt, input.ctx, input.handles);
}

function dispatchReservedAttachedAgent(
	input: AttachSessionDispatchInput,
	dispatcher: ChildAgentDispatcher,
	reservedRuntime: OwnedAgentRuntime,
): Promise<AgentSnapshot> {
	if (reservedRuntime.lifecycle.agent.lifecycle === "running") {
		return runAgentDispatcher(
			input.store,
			dispatcher,
			reservedRuntime.lifecycle.agent,
			input.prompt,
			input.ctx,
			reservedRuntime,
		);
	}
	return dispatchReservedAgent(input.store, dispatcher, reservedRuntime, input.prompt, input.ctx);
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
		model: profile.modelMetadata ?? parent?.model,
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

function buildAttachedSessionPermission(store: MultiAgentStore, parentId: string | undefined): AgentSnapshot["permission"] {
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
		const session = SessionManager.open(path, ctx.sessionManager?.getSessionDir());
		return {
			ok: true,
			target: {
				cwd: session.getCwd(),
				name: session.getSessionName(),
				path: session.getSessionFile() ?? path,
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
	return { ok: true, target: { cwd: match.session.cwd, name: match.session.name, path: match.session.path, sessionId: match.session.id } };
}

function countAttachSessionSelectors(target: { name?: string; path?: string; sessionId?: string }): number {
	const selectors = [target.name, target.path, target.sessionId];
	return selectors.filter((value) => value !== undefined && value !== "").length;
}

type AttachSessionMatchResult =
	| { status: "found"; session: SessionInfo }
	| { status: "ambiguous"; selector: string }
	| { status: "not_found" };

async function findAttachSessionMatch(
	ctx: ExtensionContext,
	target: { name?: string; sessionId?: string },
): Promise<AttachSessionMatchResult> {
	const sessionDir = ctx.sessionManager?.getSessionDir();
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
	sessions: SessionInfo[],
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

function startToolDispatch(
	store: MultiAgentStore,
	dispatches: ActiveAgentDispatches,
	agent: AgentSnapshot,
	dispatch: () => Promise<AgentSnapshot>,
	desktopNotifier: AgentDesktopNotifier,
	waitingDesktopNotifications: WaitingDesktopNotificationHandles,
	handles: BackgroundSessionHandles | undefined,
	reservedRuntime: OwnedAgentRuntime,
): AgentSnapshot {
	const unsubscribeLifecycleNotifications = store.subscribeLifecycleNotifications((message) => {
		if (message.fromAgentId !== agent.id) {
			return;
		}
		const notificationHandle = notifyWaitingAgent(message, desktopNotifier);
		if (isWaitingForInputNotification(message)) {
			rememberWaitingDesktopNotification(store, message, notificationHandle, waitingDesktopNotifications);
		} else {
			closeWaitingDesktopNotification(message.fromAgentId, waitingDesktopNotifications);
		}
	});
	const trackedDispatch = trackAgentDispatch(store, dispatches, agent, dispatch(), reservedRuntime, handles);
	void trackedDispatch.finally(() => {
		unsubscribeLifecycleNotifications();
		closeWaitingDesktopNotificationWhenNotWaiting(store, agent.id, waitingDesktopNotifications);
	});

	return store.getAgent(agent.id) ?? agent;
}

function trackAgentDispatch(
	store: MultiAgentStore,
	dispatches: ActiveAgentDispatches,
	agent: AgentSnapshot,
	dispatch: Promise<AgentSnapshot>,
	reservedRuntime: OwnedAgentRuntime,
	handles?: BackgroundSessionHandles,
): Promise<AgentSnapshot> {
	const restoreGeneration = store.getRestoreGeneration();
	const trackedDispatch = dispatch.catch((error: unknown) => {
		const current = store.getAgent(agent.id) ?? agent;
		return finalizeReservedRuntime(
			store,
			current,
			"failed",
			{ error: { message: error instanceof Error ? error.message : String(error) } },
			reservedRuntime,
			restoreGeneration,
		);
	});
	dispatches.set(agent.id, trackedDispatch);
	void trackedDispatch.finally(() => {
		if (dispatches.get(agent.id) === trackedDispatch) {
			handles?.delete(agent.id);
			dispatches.delete(agent.id);
		}
	});

	return trackedDispatch;
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
		childSession.dispose?.();
		return store.getAgent(lifecycle.agent.id) ?? lifecycle.agent;
	}
	const running = coordinator.confirmChildRuntime(lifecycle);
	if (!running.ok) {
		childSession.abort?.();
		childSession.dispose?.();
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

async function runAgentSession(
	store: MultiAgentStore,
	createChildSession: ChildAgentSessionFactory,
	runningAgent: AgentSnapshot,
	prompt: string,
	ctx: ExtensionContext,
	handles: BackgroundSessionHandles | undefined,
	createdSession: ChildAgentSession | undefined,
	reservedRuntime: OwnedAgentRuntime,
	expectedRestoreGeneration?: number,
): Promise<AgentSnapshot> {
	const restoreGeneration = expectedRestoreGeneration ?? store.getRestoreGeneration();
	const running = { agent: runningAgent };
	let childSession: ChildAgentSession | undefined;
	let unregisterAbortHandler: (() => void) | undefined;
	let unregisterLeaseAbort: (() => void) | undefined;
	try {
		const activeSession =
			createdSession ??
			(await createChildSession({
				agent: running.agent,
				ctx,
				prompt,
				signal: reservedRuntime.abortController.signal,
			}));
		childSession = activeSession;
		const leaseSignal = reservedRuntime.abortController.signal;
		const abortForLeaseLoss = () => activeSession.abort?.();
		leaseSignal.addEventListener("abort", abortForLeaseLoss, { once: true });
		unregisterLeaseAbort = () => leaseSignal.removeEventListener("abort", abortForLeaseLoss);
		if (leaseSignal.aborted) activeSession.abort?.();
		const current = store.getAgent(running.agent.id);
		if (store.getRestoreGeneration() !== restoreGeneration || !current || !isActiveLifecycle(current.lifecycle)) {
			activeSession.abort?.();
			return current ?? running.agent;
		}

		unregisterAbortHandler = store.registerAgentAbortHandler(running.agent.id, () => {
			activeSession.abort?.();
			handles?.delete(running.agent.id);
		});
		handles?.set(running.agent.id, activeSession);
		if (activeSession.transcript) {
			store.updateAgentTranscript(running.agent.id, activeSession.transcript);
		}
		await activeSession.prompt(prompt);
		await waitForActiveDescendants(store, running.agent.id, reservedRuntime.abortController.signal);
		const cancelled = acknowledgeCancelledRuntime(store, running.agent.id, reservedRuntime, restoreGeneration);
		if (cancelled) return cancelled;
		while (true) {
			const summary = lastAssistantText(activeSession.messages);
			const result = summary ? { summary } : undefined;
			const currentSnapshot = store.getAgent(running.agent.id);
			const completed = finalizeReservedRuntime(
				store,
				currentSnapshot ?? running.agent,
				"completed",
				{ result },
				reservedRuntime,
				restoreGeneration,
			);
			if (completed.lifecycle !== "steering_pending") {
				return completed;
			}
			if (!activeSession.drainRuntimeCoordination) {
				throw new Error("Child session cannot drain pending steering before completion");
			}
			await activeSession.drainRuntimeCoordination();
			const current = store.getAgent(running.agent.id);
			if (current?.lifecycle === "steering_pending") {
				throw new Error("Child session did not deliver pending steering before completion");
			}
		}

	} catch (error) {
		await waitForActiveDescendants(store, running.agent.id);
		const cancelled = acknowledgeCancelledRuntime(store, running.agent.id, reservedRuntime, restoreGeneration);
		if (cancelled) return cancelled;
		const failure = { message: error instanceof Error ? error.message : String(error) };
		const current = store.getAgent(running.agent.id) ?? running.agent;
		return finalizeReservedRuntime(store, current, "failed", { error: failure }, reservedRuntime, restoreGeneration);
	} finally {
		unregisterLeaseAbort?.();
		unregisterAbortHandler?.();
		handles?.delete(running.agent.id);
		childSession?.dispose?.();
	}
}

async function dispatchReservedAgent(
	store: MultiAgentStore,
	dispatcher: ChildAgentDispatcher,
	reservedRuntime: OwnedAgentRuntime,
	prompt: string,
	ctx: ExtensionContext,
): Promise<AgentSnapshot> {
	const running = reservedRuntime.coordinator.confirmChildRuntime(reservedRuntime.lifecycle);
	if (!running.ok) return reservedRuntime.lifecycle.agent;
	store.publishLifecycleCoordinatorSnapshot(running.agent);
	return runAgentDispatcher(store, dispatcher, running.agent, prompt, ctx, {
		...reservedRuntime,
		lifecycle: { agent: running.agent, ownership: reservedRuntime.lifecycle.ownership },
	});
}

async function runAgentDispatcher(
	store: MultiAgentStore,
	dispatcher: ChildAgentDispatcher,
	runningAgent: AgentSnapshot,
	prompt: string,
	ctx: ExtensionContext,
	reservedRuntime: OwnedAgentRuntime,
): Promise<AgentSnapshot> {
	const restoreGeneration = store.getRestoreGeneration();
	const running = { agent: runningAgent };
	const unregisterAbortHandler = store.registerAgentAbortHandler(runningAgent.id, () => {
		reservedRuntime.abortController.abort();
	});
	try {
		const dispatchResult = await dispatcher({
			agent: running.agent,
			ctx,
			prompt,
			signal: reservedRuntime.abortController.signal,
		});
		await waitForActiveDescendants(store, running.agent.id, reservedRuntime.abortController.signal);
		const cancelled = acknowledgeCancelledRuntime(store, running.agent.id, reservedRuntime, restoreGeneration);
		if (cancelled) return cancelled;
		const current = store.getAgent(running.agent.id) ?? running.agent;
		if (dispatchResult.lifecycle === "waiting_for_input") {
			const waiting = reservedRuntime.coordinator.markWaitingForInput({
				agent: current,
				ownership: reservedRuntime.lifecycle.ownership,
			});
			if (!waiting.ok) return current;
			store.publishLifecycleCoordinatorSnapshot(waiting.agent);
			return waiting.agent;
		}
		return finalizeReservedRuntime(
			store,
			current,
			dispatchResult.lifecycle,
			{ error: dispatchResult.error, result: dispatchResult.result },
			reservedRuntime,
			restoreGeneration,
		);
	} catch (error) {
		await waitForActiveDescendants(store, running.agent.id);
		const cancelled = acknowledgeCancelledRuntime(store, running.agent.id, reservedRuntime, restoreGeneration);
		if (cancelled) return cancelled;
		const failure = { message: error instanceof Error ? error.message : String(error) };
		const current = store.getAgent(running.agent.id) ?? running.agent;
		return finalizeReservedRuntime(
			store,
			current,
			"failed",
			{ error: failure },
			reservedRuntime,
			restoreGeneration,
		);
	} finally {
		unregisterAbortHandler();
	}
}

async function waitForActiveDescendants(store: MultiAgentStore, agentId: string, signal?: AbortSignal): Promise<void> {
	const hasActiveDescendants = () => store.listDescendants(agentId).some((agent) => isActiveLifecycle(agent.lifecycle));
	if (!hasActiveDescendants() || signal?.aborted) return;
	await new Promise<void>((resolve) => {
		const finish = () => {
			unsubscribe();
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		const unsubscribe = store.subscribeAgentUpdates(() => {
			if (!hasActiveDescendants()) finish();
		});
		signal?.addEventListener("abort", finish, { once: true });
		if (!hasActiveDescendants() || signal?.aborted) finish();
	});
}

function finalizeReservedRuntime(
	store: MultiAgentStore,
	agent: AgentSnapshot,
	terminalLifecycle: "completed" | "failed" | "aborted",
	metadata: { error?: AgentSnapshot["error"]; result?: AgentSnapshot["result"] },
	reservedRuntime: OwnedAgentRuntime,
	expectedRestoreGeneration?: number,
): AgentSnapshot {
	if (expectedRestoreGeneration !== undefined && store.getRestoreGeneration() !== expectedRestoreGeneration) return agent;
	if (!isActiveLifecycle(agent.lifecycle)) return agent;
	const finalized = reservedRuntime.coordinator.finalizeChild({
		agent,
		error: metadata.error,
		ownership: reservedRuntime.lifecycle.ownership,
		result: metadata.result,
		terminalLifecycle,
	});
	if (!finalized.ok) return store.getAgent(agent.id) ?? agent;
	publishCoordinatorSnapshot(store, finalized.agent);
	return finalized.agent;
}

function publishCoordinatorSnapshot(store: MultiAgentStore, agent: AgentSnapshot): void {
	store.publishLifecycleCoordinatorSnapshot(agent);
	if (isActiveLifecycle(agent.lifecycle)) return;
	const persistence = store.getPersistenceTarget();
	if (!persistence) return;
	deliverTerminalOutboxProjections({
		claimId: randomUUID(),
		controlDbPath: persistence.controlDbPath,
		now: () => new Date().toISOString(),
		store,
	});
}

function acknowledgeCancelledRuntime(
	store: MultiAgentStore,
	agentId: string,
	reservedRuntime: OwnedAgentRuntime | undefined,
	expectedRestoreGeneration?: number,
): AgentSnapshot | undefined {
	if (!reservedRuntime) return undefined;
	if (expectedRestoreGeneration !== undefined && store.getRestoreGeneration() !== expectedRestoreGeneration) return undefined;
	const current = store.getAgent(agentId);
	if (current?.lifecycle !== "cancelling") return undefined;
	const acknowledged = reservedRuntime.coordinator.acknowledgeCancellation({
		agent: current,
		ownership: reservedRuntime.lifecycle.ownership,
	});
	if (!acknowledged.ok) return current;
	publishCoordinatorSnapshot(store, acknowledged.agent);
	return acknowledged.agent;
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
	return params.activeOnly === false ? agents : agents.filter((agent) => isActiveLifecycle(agent.lifecycle));
}

function agentViewer(
	store: MultiAgentStore,
	params: AgentViewerParams,
	ctx?: ExtensionContext,
): AgentToolResult<AgentViewerToolDetails> {
	if (params.storeSessionId) {
		return agentViewerFromPersistedSession(params, ctx);
	}

	const agent = store.getAgent(params.agentId);
	if (!agent) {
		return errorResult(`Agent not found: ${params.agentId}.`, { agentId: params.agentId, error: "not_found" as const });
	}
	if (params.sessionId && agent.transcript?.sessionId !== params.sessionId) {
		return errorResult(`Agent ${params.agentId} is not attached to session ${params.sessionId}.`, {
			agentId: params.agentId,
			error: "session_mismatch" as const,
			sessionId: params.sessionId,
		});
	}

	return agentViewerResult(agent, store.listAgents());
}

function agentViewerFromPersistedSession(
	params: AgentViewerParams,
	ctx?: ExtensionContext,
): AgentToolResult<AgentViewerToolDetails> {
	const loaded = loadPersistedAgentsForViewer(params, ctx);
	if (loaded.error) {
		return loaded.error;
	}

	const agent = loaded.agents.find((candidate) => candidate.id === params.agentId);
	if (!agent) {
		return errorResult(`Agent not found: ${params.agentId}.`, {
			agentId: params.agentId,
			error: "not_found" as const,
			storeSessionId: params.storeSessionId,
		});
	}
	if (params.sessionId && agent.transcript?.sessionId !== params.sessionId) {
		return errorResult(`Agent ${params.agentId} is not attached to session ${params.sessionId}.`, {
			agentId: params.agentId,
			error: "session_mismatch" as const,
			sessionId: params.sessionId,
			storeSessionId: params.storeSessionId,
		});
	}

	return agentViewerResult(agent, loaded.agents);
}

function loadPersistedAgentsForViewer(
	params: AgentViewerParams,
	ctx?: ExtensionContext,
): { agents: AgentSnapshot[]; error?: undefined } | { agents?: undefined; error: AgentToolResult<AgentViewerToolDetails> } {
	const controlDbPath = ctx?.controlDbPath;
	if (!controlDbPath) {
		return {
			error: errorResult("Cannot view a persisted agent without a control DB.", {
				agentId: params.agentId,
				error: "missing_control_db" as const,
				storeSessionId: params.storeSessionId,
			}),
		};
	}

	const session = listSessionMetadata(controlDbPath).find((metadata) => metadata.id === params.storeSessionId);
	if (!session) {
		return {
			error: errorResult(`Session not found: ${params.storeSessionId}.`, {
				agentId: params.agentId,
				error: "session_not_found" as const,
				storeSessionId: params.storeSessionId,
			}),
		};
	}

	const state = readMultiAgentState(controlDbPath, session.sessionPath);
	return { agents: state?.agents.filter(isPersistedAgentSnapshot) ?? [] };
}

function isPersistedAgentSnapshot(value: unknown): value is AgentSnapshot {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Partial<AgentSnapshot>;
	return typeof candidate.id === "string" && typeof candidate.lifecycle === "string" && typeof candidate.revision === "number";
}

function agentViewerResult(agent: AgentSnapshot, agents: AgentSnapshot[]): AgentToolResult<AgentViewerToolDetails> {
	const children = agents.filter((candidate) => candidate.parentId === agent.id).map((child) => child.id);

	return result(formatAgentViewerContent(agent), {
		agent,
		children,
		commands: listViewerCommands([agent]),
		parentId: agent.parentId,
		status: viewStatus(agent),
		transcript: viewTranscript(agent),
	});
}

function formatAgentViewerContent(agent: AgentSnapshot): string {
	const status = agentStatusLabel(agent);
	const terminal = status === "terminal";
	const lines = [
		`Viewing agent ${agent.id}: name=${JSON.stringify(agent.displayName)} type=${agent.agentType} status=${status} lifecycle=${agent.lifecycle}`,
	];
	if (terminal && agent.result?.summary) {
		lines.push(`Summary: ${agent.result.summary}`);
	}
	if (terminal && agent.error?.message) {
		lines.push(`Error: ${agent.error.message}${agent.error.code ? ` (${agent.error.code})` : ""}`);
	}
	return lines.join("\n");
}

function viewStatus(agent: AgentSnapshot): AgentViewerStatus {
	return {
		agentId: agent.id,
		lifecycle: agent.lifecycle,
		revision: agent.revision,
		terminal: agent.lifecycle === "completed" || agent.lifecycle === "failed" || agent.lifecycle === "aborted",
	};
}

function viewTranscript(agent: AgentSnapshot): AgentViewerTranscript | undefined {
	if (!agent.transcript) {
		return undefined;
	}
	return {
		agentId: agent.id,
		path: agent.transcript.path,
		sessionId: agent.transcript.sessionId,
	};
}

function listViewerCommands(agents: AgentSnapshot[]): AgentViewerCommand[] {
	return agents.flatMap((agent) => [
		{ agentId: agent.id, command: "stop", tool: "cancel_agent" },
		{ agentId: agent.id, command: "steer", tool: "steer_agent" },
	]);
}


function sendAgentMessage(
	store: MultiAgentStore,
	params: SendAgentMessageParams,
	ctx?: ExtensionContext,
	onSessionMessageSent?: MultiAgentExtensionOptions["onSessionMessageSent"],
): AgentToolResult<SendAgentMessageToolDetails> {
	if (params.toSessionId) {
		if (isMainRuntimeTarget(params.toAgentId)) {
			return sendMainRuntimeSessionMessage(store, params, ctx, onSessionMessageSent);
		}
		const targetSessionId = resolveAgentRuntimeSessionId(store, params.toAgentId);
		if (targetSessionId !== undefined && targetSessionId !== params.toSessionId) {
			return errorResult(
				`Could not send agent message to ${params.toAgentId}: target session does not match ${params.toSessionId}.`,
				{
					agent: currentMessageSenderAgent(store, ctx),
					message: emptyDirectMessage(
						currentMessageSenderId(store, ctx) ?? "unknown_subagent",
						params.toAgentId,
						params.message,
					),
				},
			);
		}
	}

	const senderId = currentMessageSenderId(store, ctx);
	if (!senderId) {
		return errorResult("Could not send agent message: subagent runtime identity is unavailable.", {
			agent: emptyAgent("unknown_subagent"),
			message: emptyDirectMessage("unknown_subagent", params.toAgentId, params.message),
		});
	}
	const sender = store.getAgent(senderId);
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
		return errorResult(`Could not send agent message from ${senderId}: ${sent.error}`, {
			agent: "current" in sent ? sent.current : emptyAgent(senderId),
			message: emptyDirectMessage(senderId, params.toAgentId, params.message),
		});
	}

	if (params.toSessionId) {
		const recipientAgentId = isMainRuntimeTarget(params.toAgentId) ? null : params.toAgentId;
		if (!mirrorRuntimeSessionMessage(store, sent.message, params.toSessionId, ctx, recipientAgentId)) {
			const failedMessage = markFailedMailboxTransportMessage(store, sent.message);
			return errorResult("Could not send runtime session message: runtime mailbox transport is unavailable.", {
				agent: sent.agent,
				message: failedMessage,
			});
		}
		onSessionMessageSent?.({ message: sent.message, toSessionId: params.toSessionId });
	} else if (!mirrorRuntimeMailboxMessage(store, sent.message, ctx)) {
		const failedMessage = markFailedMailboxTransportMessage(store, sent.message);
		return errorResult("Could not send agent message: runtime mailbox transport is unavailable.", {
			agent: sent.agent,
			message: failedMessage,
		});
	}

	return result(`Sent message to ${formatSentMessageTarget(sent.message, params.toSessionId)}.`, {
		agent: sent.agent,
		message: sent.message,
	});
}

function sendMainRuntimeSessionMessage(
	store: MultiAgentStore,
	params: SendAgentMessageParams,
	ctx: ExtensionContext | undefined,
	onSessionMessageSent?: MultiAgentExtensionOptions["onSessionMessageSent"],
): AgentToolResult<SendAgentMessageToolDetails> {
	const sender = currentMessageSenderAgent(store, ctx);
	const senderId = currentMessageSenderId(store, ctx);
	if (!params.toSessionId) {
		return errorResult("Could not send runtime session message: target session unavailable.", {
			agent: sender,
			message: emptyDirectMessage(senderId ?? "unknown_subagent", params.toAgentId, params.message),
		});
	}
	if (!senderId) {
		return errorResult("Could not send runtime session message: subagent runtime identity is unavailable.", {
			agent: sender,
			message: emptyDirectMessage("unknown_subagent", params.toAgentId, params.message),
		});
	}
	const message = store.recordOutboundSessionMessage({
		fileRefs: params.fileRefs,
		body: params.message,
		fromAgentId: senderId,
		threadId: params.threadId,
		toAgentId: params.toAgentId,
	});
	if (!mirrorRuntimeSessionMessage(store, message, params.toSessionId, ctx, null)) {
		const failedMessage = markFailedMailboxTransportMessage(store, message);
		return errorResult("Could not send runtime session message: runtime mailbox transport is unavailable.", {
			agent: sender,
			message: failedMessage,
		});
	}
	onSessionMessageSent?.({ message, toSessionId: params.toSessionId });
	return result(`Sent message to session ${params.toSessionId}.`, {
		agent: sender,
		message,
	});
}

function markFailedMailboxTransportMessage(
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

function mirrorRuntimeSessionMessage(
	store: MultiAgentStore,
	message: AgentMailboxMessage,
	toSessionId: string,
	ctx: ExtensionContext | undefined,
	recipientAgentId: string | null,
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
			recipient: { agentId: recipientAgentId, sessionId: toSessionId },
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

function currentMessageSenderId(_store: MultiAgentStore, ctx: ExtensionContext | undefined): string | undefined {
	if (ctx?.multiAgentAgentId) {
		return ctx.multiAgentAgentId;
	}
	if (ctx?.multiAgentRequiresAgentId) {
		return undefined;
	}
	return ctx?.sessionManager?.isSubagentSession?.() ? undefined : MAIN_THREAD_AGENT_ID;
}

function currentMessageSenderAgent(store: MultiAgentStore, ctx: ExtensionContext | undefined): AgentSnapshot {
	const senderId = currentMessageSenderId(store, ctx) ?? "unknown_subagent";
	return store.getAgent(senderId) ?? emptyAgent(senderId);
}

function resolveAgentRuntimeSessionId(store: MultiAgentStore, toAgentId: string): string | null | undefined {
	const target = store.getAgent(toAgentId);
	return target ? (target.transcript?.sessionId ?? null) : undefined;
}

function isMainRuntimeTarget(toAgentId: string): boolean {
	return toAgentId === MAIN_THREAD_AGENT_ID || toAgentId === "supervisor";
}

function formatSentMessageTarget(message: AgentMailboxMessage, toSessionId: string | undefined): string {
	return toSessionId ? `${message.toAgentId} in session ${toSessionId}` : message.toAgentId;
}

type WaitAgentsWake =
	| { kind: "agent"; agent: AgentSnapshot }
	| { kind: "cancelled" }
	| { kind: "coordination" }
	| { kind: "error"; error: unknown }
	| { kind: "none" };

type RuntimeCoordinationRecipient = {
	address: RuntimeMailboxAddress;
	controlDbPath: string;
};

class WaitAgentsWakeWatcher {
	private readonly activeAgents: AgentSnapshot[];
	private readonly controlDbPath: string;
	private readonly recipient: RuntimeCoordinationRecipient | undefined;
	private readonly sessionPath: string;
	private readonly signal: AbortSignal | undefined;
	private readonly store: MultiAgentStore;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private resolve: ((wake: WaitAgentsWake) => void) | undefined;
	private runtimeSignalHandler: (() => void) | undefined;
	private settled = false;
	private unsubscribeAgentTransitions = () => {};

	constructor(
		store: MultiAgentStore,
		activeAgents: AgentSnapshot[],
		controlDbPath: string,
		sessionPath: string,
		signal: AbortSignal | undefined,
		recipient: RuntimeCoordinationRecipient | undefined,
	) {
		this.activeAgents = activeAgents;
		this.controlDbPath = controlDbPath;
		this.sessionPath = sessionPath;
		this.recipient = recipient;
		this.signal = signal;
		this.store = store;
	}

	wait(): Promise<WaitAgentsWake> {
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
			this.finish({ kind: "none" });
			return;
		}
		const readTrackedTerminal = (): AgentSnapshot | undefined => {
			const agents = (readMultiAgentState(this.controlDbPath, this.sessionPath)?.agents ?? []) as AgentSnapshot[];
			return agents.find((agent) => trackedAgentIds.has(agent.id) && !isActiveLifecycle(agent.lifecycle));
		};
		this.unsubscribeAgentTransitions = this.store.subscribeAgentTransitions(() => {
			const terminal = readTrackedTerminal();
			if (terminal) this.finish({ agent: terminal, kind: "agent" });
		});
		this.signal?.addEventListener("abort", this.onAbort, { once: true });
		this.startRuntimeCoordinationWatch();

		const terminalAgent = readTrackedTerminal();
		if (terminalAgent) {
			this.finish({ agent: terminalAgent, kind: "agent" });
			return;
		}
		this.checkCoordination();
	}

	private startRuntimeCoordinationWatch(): void {
		if (!this.recipient) return;
		this.pollTimer = setInterval(this.checkCoordination, RUNTIME_COORDINATION_POLL_INTERVAL_MS);
		if (process.platform === "win32") return;
		this.runtimeSignalHandler = this.checkCoordination;
		process.prependListener("SIGUSR2", this.runtimeSignalHandler);
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

	private finish(wake: WaitAgentsWake): void {
		if (this.settled) return;
		this.settled = true;
		this.cleanup();
		this.resolve?.(wake);
		this.resolve = undefined;
	}

	private cleanup(): void {
		this.unsubscribeAgentTransitions();
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
		if (this.runtimeSignalHandler) {
			process.off("SIGUSR2", this.runtimeSignalHandler);
			this.runtimeSignalHandler = undefined;
		}
		this.signal?.removeEventListener("abort", this.onAbort);
	}
}

async function waitAgents(
	store: MultiAgentStore,
	signal: AbortSignal | undefined,
	ctx?: ExtensionContext,
): Promise<AgentToolResult<WaitAgentsToolDetails>> {
	if (ctx && isChildAgentRuntime(ctx)) {
		return errorResult(CHILD_ORCHESTRATION_UNAVAILABLE_MESSAGE, {});
	}
	if (ctx) mirrorPendingLifecycleRuntimeMailboxMessages(store, ctx);
	const persistence = store.getPersistenceTarget();
	if (!persistence) return errorResult("wait_agents requires a persisted supervisor session.", {});
	const pending = takePendingTerminalNotification(store, persistence.controlDbPath, persistence.sessionPath);
	if (pending) return pending;
	const wake = await waitForAgentOrCoordination(
		store,
		persistence.controlDbPath,
		persistence.sessionPath,
		signal,
		runtimeCoordinationRecipient(ctx),
	);
	if (wake.kind === "cancelled") return errorResult("Wait cancelled.", {});
	if (wake.kind === "coordination") return result("Mailbox or shared-channel message received.", {});
	if (wake.kind === "error") {
		const message = wake.error instanceof Error ? wake.error.message : String(wake.error);
		return errorResult(`Wait failed: ${message}`, {});
	}
	if (wake.kind === "none") return emptyResult();
	return (
		takePendingTerminalNotification(store, persistence.controlDbPath, persistence.sessionPath) ??
		result(formatAgentStatus(wake.agent), { agent: wake.agent })
	);
}

function runtimeCoordinationRecipient(ctx: ExtensionContext | undefined): RuntimeCoordinationRecipient | undefined {
	if (!ctx?.controlDbPath) return undefined;
	const address = resolveOwnMainRuntimeCoordinationRecipient(ctx.controlDbPath);
	if (!address) return undefined;
	return { address, controlDbPath: ctx.controlDbPath };
}

function takePendingTerminalNotification(
	store: MultiAgentStore,
	controlDbPath: string,
	sessionPath: string,
): AgentToolResult<WaitAgentsToolDetails> | undefined {
	const agents = (readMultiAgentState(controlDbPath, sessionPath)?.agents ?? []) as AgentSnapshot[];
	for (const agent of agents) {
		const lifecycle = agent.lifecycle === "completed" ? "completed" : agent.lifecycle === "failed" ? "failed" : undefined;
		if (!lifecycle) continue;
		const message = store.listPendingLifecycleNotificationsForAgent(agent.id, lifecycle)[0];
		if (!message) continue;
		store.markMailboxMessageDelivered(message.id);
		return result(message.body ?? formatAgentStatus(agent), { agent, message });
	}
	return undefined;
}

async function waitForAgentOrCoordination(
	store: MultiAgentStore,
	controlDbPath: string,
	sessionPath: string,
	signal: AbortSignal | undefined,
	recipient: RuntimeCoordinationRecipient | undefined,
): Promise<WaitAgentsWake> {
	if (signal?.aborted) return Promise.resolve({ kind: "cancelled" });
	const agents = (readMultiAgentState(controlDbPath, sessionPath)?.agents ?? []) as AgentSnapshot[];
	return new WaitAgentsWakeWatcher(
		store,
		agents.filter((agent) => isActiveLifecycle(agent.lifecycle)),
		controlDbPath,
		sessionPath,
		signal,
		recipient,
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
	| { ok: false; error: "agent_not_found" | "runtime_ownership_unavailable" | "mutation_rejected"; agent?: AgentSnapshot };

export async function cancelOwnedAgentRuntime(
	store: MultiAgentStore,
	runtimeHandles: MultiAgentRuntimeHandles,
	agentId: string,
	reason?: string,
): Promise<CancelReservedAgentResult> {
	const descendants = store.listDescendants(agentId).filter((agent) => isActiveLifecycle(agent.lifecycle)).reverse();
	for (const descendant of descendants) {
		const cancelled = await cancelOneOwnedAgentRuntime(store, runtimeHandles, descendant.id, reason);
		if (!cancelled.ok) return cancelled;
	}
	return cancelOneOwnedAgentRuntime(store, runtimeHandles, agentId, reason);
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
	reason?: string,
): Promise<CancelReservedAgentResult> {
	const current = store.getAgent(agentId);
	if (!current) return { ok: false, error: "agent_not_found" };
	const reservedRuntime = runtimeHandles.ownerships.get(agentId);
	if (!reservedRuntime) return cancelPersistedDetachedRuntime(store, current, reason);
	const cancelling = reservedRuntime.coordinator.requestCancellation({
		agent: current,
		ownership: reservedRuntime.lifecycle.ownership,
	});
	if (!cancelling.ok) return { ok: false, error: "mutation_rejected", agent: current };
	store.publishLifecycleCoordinatorSnapshot(cancelling.agent);
	abortAgentHandleSafely(store, agentId);
	const dispatch = runtimeHandles.dispatches.get(agentId);
	if (dispatch) {
		await Promise.race([
			dispatch,
			new Promise<void>((resolve) => setTimeout(resolve, CANCELLATION_SETTLEMENT_TIMEOUT_MS)),
		]);
	}
	const settled = store.getAgent(agentId) ?? cancelling.agent;
	return { ok: true, agent: settled };
}

function cancelPersistedDetachedRuntime(
	store: MultiAgentStore,
	agent: AgentSnapshot,
	reason?: string,
): CancelReservedAgentResult {
	const persistence = store.getPersistenceTarget();
	const outputLabel = detachedRuntimeOutputLabel(agent);
	if (!persistence || !outputLabel) {
		return { ok: false, error: "runtime_ownership_unavailable", agent };
	}
	const ownership = readMultiAgentRuntimeOwnership(persistence.controlDbPath, persistence.sessionPath, agent.id);
	const coordinator = createLifecycleCoordinator(store);
	if (!ownership?.processIdentity || !ownership.owner.sessionId || !coordinator) {
		return { ok: false, error: "runtime_ownership_unavailable", agent };
	}
	const cancelled = coordinator.requestDetachedCancellation({
		agent,
		outputLabel,
		reason,
		ownership: ownership,
	});
	if (!cancelled.ok) return { ok: false, error: "mutation_rejected", agent };
	publishCoordinatorSnapshot(store, cancelled.agent);
	return { ok: true, agent: cancelled.agent };
}

function detachedRuntimeOutputLabel(agent: AgentSnapshot): "Bash output" | "Pyrun output" | undefined {
	if (agent.agentType !== "background" || agent.worker?.adapter !== "runtime") return undefined;
	const label = agent.result?.fileRefs?.find(
		(fileRef) => fileRef.label === "Bash output" || fileRef.label === "Pyrun output",
	)?.label;
	return label === "Bash output" || label === "Pyrun output" ? label : undefined;
}

async function cancelAgent(
	store: MultiAgentStore,
	runtimeHandles: MultiAgentRuntimeHandles,
	params: CancelAgentParams,
): Promise<AgentToolResult<AgentToolDetails>> {
	const cancelled = await cancelOwnedAgentRuntime(store, runtimeHandles, params.agentId, params.reason);
	if (!cancelled.ok) {
		const error = cancelled.error === "runtime_ownership_unavailable" ? "runtime ownership unavailable" : cancelled.error;
		return errorResult(`Could not cancel ${params.agentId}: ${error}`, {
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

function contactSupervisor(
	store: MultiAgentStore,
	params: ContactSupervisorParams,
	ctx?: ExtensionContext,
): AgentToolResult<ContactSupervisorToolDetails> {
	const currentAgentId = ctx?.multiAgentAgentId;
	const requiresRuntimeIdentity = ctx?.multiAgentRequiresAgentId || ctx?.sessionManager?.isSubagentSession();
	if (requiresRuntimeIdentity && !currentAgentId) {
		return errorResult("Could not contact supervisor: subagent runtime identity is unavailable.", {
			agent: emptyAgent(params.agentId),
			message: emptySupervisorRequest(params.agentId, params.message),
		});
	}
	if (currentAgentId && currentAgentId !== params.agentId) {
		return errorResult(`Could not contact supervisor for ${params.agentId}: sender identity mismatch.`, {
			agent: emptyAgent(params.agentId),
			message: emptySupervisorRequest(params.agentId, params.message),
		});
	}
	const contacted = store.contactSupervisor(params.agentId, {
		fileRefs: params.fileRefs,
		body: params.message,
		threadId: params.threadId,
	});
	if (!contacted.ok) {
		return errorResult(`Could not contact supervisor for ${params.agentId}: ${contacted.error}`, {
			agent: "current" in contacted ? contacted.current : emptyAgent(params.agentId),
			message: emptySupervisorRequest(params.agentId, params.message),
		});
	}

	if (!mirrorRuntimeMailboxMessage(store, contacted.message, ctx)) {
		const failedMessage = markFailedMailboxTransportMessage(store, contacted.message);
		return errorResult("Could not contact supervisor: runtime mailbox transport is unavailable.", {
			agent: contacted.agent,
			message: failedMessage,
		});
	}

	return result(`Contacted supervisor for ${contacted.agent.displayName}.`, {
		agent: contacted.agent,
		message: contacted.message,
	});
}

function steerAgent(
	store: MultiAgentStore,
	params: SteerAgentParams,
	ctx?: ExtensionContext,
): AgentToolResult<AgentSteerToolDetails> {
	const senderId = currentSteeringSenderId(store, ctx);
	if (!senderId) {
		return errorResult("Could not steer agent: subagent runtime identity is unavailable.", {
			agent: emptyAgent(params.agentId),
			message: emptyMessage(params.agentId, params.message),
		});
	}
	const current = store.getAgent(params.agentId);
	if (!current) {
		return errorResult(`Could not steer ${params.agentId}: not_found`, {
			agent: emptyAgent(params.agentId),
			message: emptyMessage(params.agentId, params.message),
		});
	}

	const persistence = store.getPersistenceTarget();
	const coordinator = ctx ? createLifecycleCoordinator(store) : undefined;
	const ownership = persistence
		? readMultiAgentRuntimeOwnership(persistence.controlDbPath, persistence.sessionPath, current.id)
		: undefined;
	if (!coordinator || !ownership) {
		return errorResult(`Could not steer ${params.agentId}: runtime ownership unavailable`, {
			agent: current,
			message: emptyMessage(params.agentId, params.message),
		});
	}
	const message = store.prepareSteeringMessageForLifecycleCoordinator(params.agentId, {
		body: params.message,
		fileRefs: params.fileRefs,
		fromAgentId: senderId,
		targetCheckpoint: params.targetCheckpoint as SteeringCheckpoint | undefined,
	});
	const steered = coordinator.requestSteering({ agent: current, message, ownership });
	if (!steered.ok) {
		return errorResult(`Could not steer ${params.agentId}: ${steered.error}`, {
			agent: current,
			message: emptyMessage(params.agentId, params.message),
		});
	}
	store.publishLifecycleCoordinatorSteering(steered.agent, steered.message);

	if (!mirrorRuntimeMailboxMessage(store, steered.message, ctx)) {
		const failedMessage = markFailedMailboxTransportMessage(store, steered.message);
		return errorResult("Could not queue steering: runtime mailbox transport is unavailable.", {
			agent: steered.agent,
			message: failedMessage,
		});
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

function notifyWaitingAgent(
	message: AgentMailboxMessage,
	desktopNotifier: AgentDesktopNotifier,
): DesktopNotificationHandle | undefined {
	if (!isWaitingForInputNotification(message)) {
		return undefined;
	}
	try {
		return toDesktopNotificationHandle(
			desktopNotifier({
				body: message.body ?? `${message.fromAgentId} is waiting for input.`,
				expireTimeMs: PERSISTENT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS,
				title: "Pi agent needs input",
			}),
		);
	} catch (error) {
		console.error("Failed to send agent input-needed desktop notification:", error);
		return undefined;
	}
}

function rememberWaitingDesktopNotification(
	store: MultiAgentStore,
	message: AgentMailboxMessage,
	notificationHandle: DesktopNotificationHandle | undefined,
	waitingDesktopNotifications: WaitingDesktopNotificationHandles,
): void {
	if (!notificationHandle) {
		return;
	}
	closeWaitingDesktopNotification(message.fromAgentId, waitingDesktopNotifications);
	const unsubscribeTransition = store.subscribeAgentTransitions((previous, current) => {
		if (current.id !== message.fromAgentId || previous.lifecycle !== "waiting_for_input") {
			return;
		}
		if (current.lifecycle !== "waiting_for_input") {
			closeWaitingDesktopNotification(current.id, waitingDesktopNotifications);
		}
	});
	waitingDesktopNotifications.set(message.fromAgentId, { handle: notificationHandle, unsubscribeTransition });
}

function closeWaitingDesktopNotificationWhenNotWaiting(
	store: MultiAgentStore,
	agentId: string,
	waitingDesktopNotifications: WaitingDesktopNotificationHandles,
): void {
	const current = store.getAgent(agentId);
	if (current?.lifecycle === "waiting_for_input") {
		return;
	}
	closeWaitingDesktopNotification(agentId, waitingDesktopNotifications);
}

function closeWaitingDesktopNotification(
	agentId: string,
	waitingDesktopNotifications: WaitingDesktopNotificationHandles,
): void {
	const notificationRegistration = waitingDesktopNotifications.get(agentId);
	if (!notificationRegistration) {
		return;
	}
	waitingDesktopNotifications.delete(agentId);
	notificationRegistration.unsubscribeTransition();
	try {
		notificationRegistration.handle.close();
	} catch (error) {
		console.error("Failed to close agent input-needed desktop notification:", error);
	}
}

function isWaitingForInputNotification(message: AgentMailboxMessage): boolean {
	return (
		message.kind === "system" &&
		message.status === "pending" &&
		(message.threadId?.startsWith("agent-waiting-for-input:") ?? false)
	);
}

interface RuntimeLifecycleMirror {
	bind(ctx: ExtensionContext): void;
	dispose(): void;
}

function createRuntimeLifecycleMirror(store: MultiAgentStore): RuntimeLifecycleMirror {
	let boundCtx: ExtensionContext | undefined;
	let boundSessionId: string | undefined;
	let unsubscribe: (() => void) | undefined;
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
				mirrorLifecycleRuntimeMailboxMessage(store, message, boundCtx);
			});
			mirrorPendingLifecycleRuntimeMailboxMessages(store, ctx);
		},
		dispose() {
			unsubscribe?.();
			boundCtx = undefined;
			unsubscribe = undefined;
			boundSessionId = undefined;
		},
	};
}

function mirrorPendingLifecycleRuntimeMailboxMessages(store: MultiAgentStore, ctx: ExtensionContext): void {
	for (const agent of store.listAgents()) {
		if (!isRuntimeMirroredLifecycle(agent.lifecycle)) continue;
		for (const message of store.listPendingLifecycleNotificationsForAgent(agent.id, agent.lifecycle)) {
			mirrorLifecycleRuntimeMailboxMessage(store, message, ctx);
		}
	}
}

// Transport rows never copy message bodies: they reference the persisted store row that
// owns the content. Messaging therefore requires a store persisted to the runtime's
// control DB; there is no in-memory delivery path.
function buildRuntimeMailboxStoreRef(
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
		agent &&
		listRuntimeMailboxMessages(ctx.controlDbPath).some(
			(message) =>
				message.storeRef?.sessionPath === storeRef.sessionPath && isDetachedTerminalTransport(message, agent),
		)
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

function isDetachedTerminalTransport(message: RuntimeMailboxMessage, agent: AgentSnapshot): boolean {
	if (message.sender.agentId !== agent.id || message.kind !== "system") return false;
	try {
		const body = JSON.parse(message.body) as Record<string, unknown>;
		return body.type === "multi_agent_terminal" && body.agentId === agent.id && body.terminalRevision === agent.revision;
	} catch {
		return false;
	}
}

function isRuntimeMirroredLifecycle(
	lifecycle: AgentLifecycleState,
): lifecycle is "completed" | "failed" | "waiting_for_input" {
	return lifecycle === "completed" || lifecycle === "failed" || lifecycle === "waiting_for_input";
}

function mirrorRuntimeMailboxMessage(
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

function resolveRuntimeRecipient(
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
	return { agentId: null, sessionId: resolveParentRuntimeSessionId(ctx) ?? currentSessionId };
}

function resolveParentRuntimeSessionId(ctx: ExtensionContext): string | undefined {
	if (ctx.multiAgentParentSessionId) {
		return ctx.multiAgentParentSessionId;
	}
	if (!ctx.sessionManager.isSubagentSession()) {
		return undefined;
	}
	const parentSession = ctx.sessionManager.getHeader()?.parentSession;
	if (!parentSession) {
		return undefined;
	}
	if (!ctx.controlDbPath) {
		return parentSession;
	}
	return readSessionMetadata(ctx.controlDbPath, parentSession)?.id ?? parentSession;
}

function emptyAgent(agentId: string): AgentSnapshot {
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

function emptyMessage(agentId: string, body: string): AgentMailboxMessage {
	const timestamp = new Date(0).toISOString();
	return {
		body,
		createdAt: timestamp,
		fromAgentId: "supervisor",
		id: "",
		kind: "steer",
		status: "failed",
		toAgentId: agentId,
		updatedAt: timestamp,
	};
}

function emptySupervisorRequest(agentId: string, body: string): AgentMailboxMessage {
	const timestamp = new Date(0).toISOString();
	return {
		body,
		createdAt: timestamp,
		fromAgentId: agentId,
		id: "",
		kind: "supervisor_request",
		status: "failed",
		toAgentId: "supervisor",
		updatedAt: timestamp,
	};
}

function emptyDirectMessage(fromAgentId: string, toAgentId: string, body: string): AgentMailboxMessage {
	const timestamp = new Date(0).toISOString();
	return {
		body,
		createdAt: timestamp,
		fromAgentId,
		id: "",
		kind: "message",
		status: "failed",
		toAgentId,
		updatedAt: timestamp,
	};
}

function lastAssistantText(messages: AgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "assistant") {
			return messageText(message);
		}
	}

	return undefined;
}

function messageText(message: AgentMessage): string {
	if (!("content" in message)) {
		return "";
	}

	const content = message.content;
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export function resolveMultiAgentStore(options: MultiAgentExtensionOptions = {}): MultiAgentStore {
	return options.store ?? new MultiAgentStore();
}

export function registerAgentsCoreTools(pi: ExtensionAPI, options: MultiAgentExtensionOptions = {}) {
	const store = resolveMultiAgentStore(options);
	const createAttachedSession = options.createAttachedSession;
	const createChildSession = options.createChildSession;
	const desktopNotifier = options.desktopNotifier ?? sendDesktopNotification;
	const dispatcher = options.dispatcher;
	const runtimeHandles = options.runtimeHandles ?? createMultiAgentRuntimeHandles();
	const backgroundSessions = runtimeHandles.sessions;
	const activeDispatches = runtimeHandles.dispatches;
	const ownerships = runtimeHandles.ownerships;
	const waitingDesktopNotifications: WaitingDesktopNotificationHandles = new Map();
	const backgroundDispatch = {
		createChildSession,
		dispatcher,
		dispatches: activeDispatches,
		handles: backgroundSessions,
		ownerships,
		store,
	};
	const runtimeLifecycleMirror = createRuntimeLifecycleMirror(store);

	pi.on?.("session_start", async (_event, ctx) => {
		runtimeLifecycleMirror.bind(ctx);
		recoverAgents({
			createAttachedSession,
			ctx,
			desktopNotifier,
			dispatcher,
			dispatches: activeDispatches,
			handles: backgroundSessions,
			pi,
			ownerships,
			store,
			waitingDesktopNotifications,
		});
	});
	pi.on?.("session_shutdown", async (event) => {
		runtimeLifecycleMirror.dispose();
		if (event.reason === "reload") {
			return;
		}
		store.invalidateInFlightDispatches();
		for (const runtime of ownerships.values()) runtime.abortController.abort();
		for (const agentId of backgroundSessions.keys()) {
			if (!ownerships.has(agentId)) abortAgentHandleSafely(store, agentId);
		}
		for (const agentId of waitingDesktopNotifications.keys()) {
			closeWaitingDesktopNotification(agentId, waitingDesktopNotifications);
		}
		backgroundSessions.clear();
		activeDispatches.clear();
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
				'For scoped code changes, use agentType "implement"; for proof commands before completion, use agentType "verifier"; for final code review or second opinions, use agentType "reviewer".',
			],
			approvalRequired: false,
			parameters: spawnAgentSchema,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				runtimeLifecycleMirror.bind(ctx);
				return spawnAgent(
					store,
					createChildSession,
					dispatcher,
					activeDispatches,
					ownerships,
					params,
					ctx,
					desktopNotifier,
					waitingDesktopNotifications,
					pi,
					backgroundSessions,
				);
			},
		}),
	);

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
					createAttachedSession,
					ctx,
					desktopNotifier,
					dispatcher,
					dispatches: activeDispatches,
					handles: backgroundSessions,
					params,
					pi,
					ownerships,
					store,
					waitingDesktopNotifications,
				});
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "wait_agents",
			label: "Wait Agents",
			description:
				"Wait until any active agent reaches a terminal state or coordination input arrives, then consume the winning agent completion notification.",
			approvalRequired: false,
			parameters: waitAgentsSchema,
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				runtimeLifecycleMirror.bind(ctx);
				assertNoWaitAgentsParams(params, "wait_agents");
				return waitAgents(store, signal, ctx);
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "cancel_agent",
			label: "Cancel Agent",
			description: "Cancel an agent through the multi-agent store using the current store revision.",
			approvalRequired: false,
			parameters: cancelAgentSchema,
			execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) =>
				cancelAgent(store, runtimeHandles, params),
		}),
	);

	pi.registerTool(
		defineTool({
			name: "steer_agent",
			label: "Steer Agent",
			description: "Queue a steering message through the multi-agent mailbox.",
			approvalRequired: false,
			parameters: steerAgentSchema,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => steerAgent(store, params, ctx),
		}),
	);
}

export function registerAgentViewerTools(pi: ExtensionAPI, options: MultiAgentExtensionOptions = {}) {
	const store = resolveMultiAgentStore(options);

	pi.registerTool(
		defineTool({
			name: "agent_viewer",
			label: "Agent Viewer",
			description: "Inspect one agent by ID, with status, transcript, child IDs, and command descriptors.",
			approvalRequired: false,
			parameters: agentViewerSchema,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => agentViewer(store, params, ctx),
		}),
	);
}

export function registerAgentsMailboxTools(pi: ExtensionAPI, options: MultiAgentExtensionOptions = {}) {
	const store = resolveMultiAgentStore(options);

	pi.registerTool(
		defineTool({
			name: "send_agent_message",
			label: "Send Agent Message",
			description: "Send a sibling-safe direct mailbox message across a parent-child agent relationship.",
			approvalRequired: false,
			parameters: sendAgentMessageSchema,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
				sendAgentMessage(store, params, ctx, options.onSessionMessageSent),
		}),
	);

	pi.registerTool(
		defineTool({
			name: "contact_supervisor",
			label: "Contact Supervisor",
			description: "Send a child-agent mailbox request to its direct supervisor.",
			approvalRequired: false,
			parameters: contactSupervisorSchema,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => contactSupervisor(store, params, ctx),
		}),
	);
}

export default function multiAgentExtension(pi: ExtensionAPI, options: MultiAgentExtensionOptions = {}) {
	const store = resolveMultiAgentStore(options);
	const sharedOptions = { ...options, store };

	registerAgentsCoreTools(pi, sharedOptions);
	registerAgentViewerTools(pi, sharedOptions);
	registerAgentsMailboxTools(pi, sharedOptions);
}
