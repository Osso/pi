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
	type ReservedLifecycleCommandInput,
} from "../../../src/core/lifecycle-coordinator.ts";
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
	consumeRuntimeMailboxMessageByStoreRef,
	enqueueRuntimeMailboxMessage,
	listSessionMetadata,
	readMultiAgentDispatchLease,
	readMultiAgentState,
	readSessionMetadata,
	type RuntimeMailboxAddress,
} from "../../../src/core/session-control-db.ts";
import { SessionManager, type SessionEntry, type SessionInfo } from "../../../src/core/session-manager.ts";
import type { CreateAgentSessionOptions } from "../../../src/core/sdk.ts";
import { SUPERVISOR_ONLY_TOOL_NAMES } from "../../../src/core/tool-capabilities.ts";

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
	lifecycle: Type.Optional(Type.Union([Type.Literal("queued"), Type.Literal("starting")])),
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
	expectedRevision: Type.Number(),
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
const CHILD_DISPATCH_RESERVATION_MS = 30_000;
const CANCELLATION_SETTLEMENT_TIMEOUT_MS = 5_000;
const RUNTIME_INCARNATION = randomUUID();
const CRASH_RECOVERY_PROMPT =
	"Continue the conversation from where it left off without asking the user any further questions. Resume directly from the saved session context.";
const MESSAGE_CONTENT_LIMIT = 2000;
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

export interface MultiAgentWorkflowOperations {
	contactSupervisor(
		agentId: string,
		expectedRevision: number,
		input: ContactSupervisorInput,
	): ReturnType<MultiAgentStore["contactSupervisor"]>;
	sendAgentMessage(
		agentId: string,
		expectedRevision: number,
		input: SendMailboxMessageInput,
	): MailboxMessageCommandResult;
	spawnAgent(input: Parameters<MultiAgentStore["spawnAgent"]>[0]): ReturnType<MultiAgentStore["spawnAgent"]>;
	waitAgents(): void;
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

interface ReservedAgentRuntime {
	coordinator: LifecycleCoordinator;
	ownership: ReservedLifecycleCommandInput;
}

export interface MultiAgentRuntimeHandles {
	dispatches: ActiveAgentDispatches;
	reservations: Map<string, ReservedAgentRuntime>;
	sessions: BackgroundSessionHandles;
}

export function createMultiAgentRuntimeHandles(): MultiAgentRuntimeHandles {
	return { dispatches: new Map(), reservations: new Map(), sessions: new Map() };
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
	reservations: Map<string, ReservedAgentRuntime>;
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
	runtime: ReservedAgentRuntime,
	prompt: string,
	ctx: ExtensionCommandContext,
): AgentSnapshot {
	const agent = runtime.ownership.agent;
	if (background.createChildSession) {
		const promise = trackAgentDispatch(
			background.store,
			background.dispatches,
			agent,
			dispatchReservedAgentSession(
				background.store,
				background.createChildSession,
				runtime.ownership,
				runtime.coordinator,
				prompt,
				ctx,
				background.handles,
			),
		);
		notifyBackgroundDispatch(promise, background.handles, ctx);
		void promise.finally(() => background.reservations.delete(agent.id));
		return background.store.getAgent(agent.id) ?? agent;
	}

	if (background.dispatcher) {
		const promise = trackAgentDispatch(
			background.store,
			background.dispatches,
			agent,
			dispatchReservedAgent(
				background.store,
				background.dispatcher,
				runtime.ownership,
				runtime.coordinator,
				prompt,
				ctx,
			),
		);
		notifyBackgroundDispatch(promise, background.handles, ctx);
		void promise.finally(() => background.reservations.delete(agent.id));
		return background.store.getAgent(agent.id) ?? agent;
	}

	return agent;
}

function backgroundCommand(background: BackgroundDispatchContext, args: string, ctx: ExtensionCommandContext): void {
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

	const coordinator = createLifecycleCoordinator(background.store, ctx);
	if (!coordinator) {
		ctx.ui.notify("Background jobs require a persisted supervisor session.", "error");
		return;
	}
	const created = coordinator.createChild({
		agentType: "background",
		cwd: ctx.cwd,
		displayName: "Background Job",
		ownerSessionId: ctx.sessionManager?.getSessionId() ?? background.store.getPersistenceTarget()?.sessionPath ?? "",
		permission: { narrowed: true, policy: "on-request" },
	});
	if (!created.ok) {
		ctx.ui.notify(`Could not create background job: ${created.error}`, "error");
		return;
	}
	const starting = coordinator.beginChildRuntime({ agent: created.agent, reservation: created.reservation });
	if (!starting.ok) {
		ctx.ui.notify(`Could not reserve background runtime: ${starting.error}`, "error");
		return;
	}
	background.store.publishLifecycleCoordinatorSnapshot(starting.agent);
	const runtime = {
		coordinator,
		ownership: { agent: starting.agent, reservation: created.reservation },
	};
	background.reservations.set(starting.agent.id, runtime);
	const agent = startBackgroundDispatch(background, runtime, prompt, ctx);
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

export function createMultiAgentWorkflowOperations(store: MultiAgentStore): MultiAgentWorkflowOperations {
	return {
		contactSupervisor: (agentId, expectedRevision, input) =>
			store.contactSupervisor(agentId, expectedRevision, input),
		sendAgentMessage: (agentId, expectedRevision, input) =>
			store.sendMailboxMessage(agentId, expectedRevision, input),
		spawnAgent: (input) => store.spawnAgent(input),
		waitAgents: () => {},
	};
}

export function createHostrunMultiAgentRequestHandler(
	options: MultiAgentExtensionOptions,
): HostrunMultiAgentRequestHandler {
	const store = resolveMultiAgentStore(options);
	const runtimeHandles = options.runtimeHandles ?? createMultiAgentRuntimeHandles();
	const activeDispatches = runtimeHandles.dispatches;
	const reservations = runtimeHandles.reservations;
	const backgroundSessions = runtimeHandles.sessions;
	const desktopNotifier = options.desktopNotifier ?? sendDesktopNotification;
	const waitingDesktopNotifications: WaitingDesktopNotificationHandles = new Map();

	return async (request, ctx, signal) => {
		if (isChildAgentRuntime(ctx) && isSupervisorOnlyAgentRequest(request.method)) {
			throw new Error(CHILD_ORCHESTRATION_UNAVAILABLE_MESSAGE);
		}
		if (request.method === "agents.spawn") {
			const result = await spawnAgent(
				store,
				options.createChildSession,
				options.dispatcher,
				activeDispatches,
				reservations,
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

function createLifecycleCoordinator(store: MultiAgentStore, ctx: ExtensionContext): LifecycleCoordinator | undefined {
	const persistence = store.getPersistenceTarget();
	if (!persistence) return undefined;
	return new LifecycleCoordinator({
		controlDbPath: persistence.controlDbPath,
		createAgentId: () => store.allocateAgentIdForLifecycleCoordinator(),
		createLeaseId: randomUUID,
		now: () => new Date().toISOString(),
		reservationDurationMs: CHILD_DISPATCH_RESERVATION_MS,
		runtimeIncarnation: RUNTIME_INCARNATION,
		sessionPath: persistence.sessionPath,
	});
}

async function spawnAgent(
	store: MultiAgentStore,
	createChildSession: ChildAgentSessionFactory | undefined,
	dispatcher: ChildAgentDispatcher | undefined,
	dispatches: ActiveAgentDispatches,
	reservations: Map<string, ReservedAgentRuntime>,
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
	const coordinator = createLifecycleCoordinator(store, ctx);
	if (!coordinator) {
		return errorResult("spawn_agent requires a persisted supervisor session.", {
			agent: emptyAgent("spawn_agent"),
			dispatched: false,
			prompt: params.prompt,
		});
	}
	const created = coordinator.createChild({
		agentType,
		cwd: ctx.cwd,
		displayName,
		model: profile.modelMetadata,
		ownerSessionId: ctx.sessionManager?.getSessionId() ?? store.getPersistenceTarget()?.sessionPath ?? "",
		parentId: params.parentId,
		permission: { narrowed: true, policy: "on-request" },
	});
	if (!created.ok) {
		return errorResult(`spawn_agent failed: ${created.error}`, {
			agent: emptyAgent("spawn_agent"),
			dispatched: false,
			prompt: params.prompt,
		});
	}
	const starting = coordinator.beginChildRuntime({ agent: created.agent, reservation: created.reservation });
	if (!starting.ok) {
		return errorResult(`spawn_agent failed to reserve runtime start: ${starting.error}`, {
			agent: created.agent,
			dispatched: false,
			prompt: params.prompt,
		});
	}
	store.publishLifecycleCoordinatorSnapshot(starting.agent);
	const ownership: ReservedLifecycleCommandInput = {
		agent: starting.agent,
		reservation: created.reservation,
	};
	reservations.set(starting.agent.id, { coordinator, ownership });

	if (createChildSession) {
		const agent = startToolDispatch(
			store,
			dispatches,
			starting.agent,
			() => dispatchReservedAgentSession(store, createChildSession, ownership, coordinator, params.prompt, ctx, handles),
			ctx,
			pi,
			desktopNotifier,
			waitingDesktopNotifications,
			handles,
		);
		releaseReservationAfterDispatch(dispatches, reservations, agent.id);
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
			starting.agent,
			() => dispatchReservedAgent(store, dispatcher, ownership, coordinator, params.prompt, ctx),
			ctx,
			pi,
			desktopNotifier,
			waitingDesktopNotifications,
		);
		releaseReservationAfterDispatch(dispatches, reservations, agent.id);
		return result(`Spawned ${agent.displayName} (${agent.id})`, {
			agent,
			dispatched: true,
			prompt: params.prompt,
		});
	}

	throw new Error("spawn_agent executable runtime invariant violated");
}

function releaseReservationAfterDispatch(
	dispatches: ActiveAgentDispatches,
	reservations: Map<string, ReservedAgentRuntime>,
	agentId: string,
): void {
	const dispatch = dispatches.get(agentId);
	if (dispatch) void dispatch.finally(() => reservations.delete(agentId));
}

interface AttachSessionAgentRuntimeInput {
	createAttachedSession: AttachedSessionFactory | undefined;
	ctx: ExtensionContext;
	desktopNotifier: AgentDesktopNotifier;
	dispatcher: ChildAgentDispatcher | undefined;
	dispatches: ActiveAgentDispatches;
	handles?: BackgroundSessionHandles;
	params: AttachSessionAgentParams;
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
	prompt: string;
	store: MultiAgentStore;
	target: AgentSnapshot;
	waitingDesktopNotifications: WaitingDesktopNotificationHandles;
}

type AttachSessionResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: string; parent?: AgentSnapshot };

function dispatchAttachedSessionAgent(input: AttachSessionDispatchInput): AgentSnapshot | undefined {
	const createAttachedSession = input.createAttachedSession;
	if (createAttachedSession) {
		return startToolDispatch(
			input.store,
			input.dispatches,
			input.target,
			() => dispatchAttachedChildSession(input, createAttachedSession),
			input.ctx,
			input.pi,
			input.desktopNotifier,
			input.waitingDesktopNotifications,
			input.handles,
		);
	}
	const dispatcher = input.dispatcher;
	if (!dispatcher) {
		return undefined;
	}
	return startToolDispatch(
		input.store,
		input.dispatches,
		input.target,
		() => dispatchAgent(input.store, dispatcher, input.target, input.prompt, input.ctx),
		input.ctx,
		input.pi,
		input.desktopNotifier,
		input.waitingDesktopNotifications,
	);
}

function recoverDetachedAgents(
	input: Omit<AttachSessionDispatchInput, "prompt" | "target">,
	recoveryTimers: Map<string, ReturnType<typeof setTimeout>>,
): void {
	if (input.ctx.multiAgentAgentId) {
		return;
	}
	for (const agent of input.store.listActiveAgents()) {
		recoverDetachedAgent(input, agent, recoveryTimers);
	}
}

function recoverDetachedAgent(
	input: Omit<AttachSessionDispatchInput, "prompt" | "target">,
	agent: AgentSnapshot,
	recoveryTimers: Map<string, ReturnType<typeof setTimeout>>,
): void {
	if (input.dispatches.has(agent.id) || (agent.lifecycle === "queued" && agent.origin === "attached")) return;
	if (agent.origin !== "attached") {
		scheduleSpawnedAgentRecovery(input, agent, recoveryTimers);
		return;
	}
	if (agent.lifecycle === "cancelling") {
		transitionActiveAgent(input.store, agent, "aborted");
		return;
	}
	if (!isInFlightLifecycle(agent.lifecycle)) {
		return;
	}
	if (input.createAttachedSession && agent.transcript?.path) {
		dispatchAttachedSessionAgent({ ...input, prompt: CRASH_RECOVERY_PROMPT, target: agent });
		return;
	}
	if (!agent.transcript?.path) {
		transitionActiveAgent(input.store, agent, "failed", {
			error: { message: "Agent was active when the supervisor session ended and has no recoverable transcript." },
		});
	}
}

function scheduleSpawnedAgentRecovery(
	input: Omit<AttachSessionDispatchInput, "prompt" | "target">,
	agent: AgentSnapshot,
	recoveryTimers: Map<string, ReturnType<typeof setTimeout>>,
): void {
	if (recoveryTimers.has(agent.id)) return;
	const persistence = input.store.getPersistenceTarget();
	if (!persistence) return;
	const lease = readMultiAgentDispatchLease(persistence.controlDbPath, persistence.sessionPath, agent.id);
	if (!lease?.expiresAt) return;
	const delayMs = Math.max(0, Date.parse(lease.expiresAt) - Date.now() + 1);
	const timer = setTimeout(() => {
		recoveryTimers.delete(agent.id);
		const current = input.store.getAgent(agent.id);
		if (!current || !isActiveLifecycle(current.lifecycle)) return;
		const coordinator = createLifecycleCoordinator(input.store, input.ctx);
		if (!coordinator) return;
		const ownerSessionId = input.ctx.sessionManager?.getSessionId() ?? persistence.sessionPath;
		const recovered = coordinator.recoverExpiredChild({ agent: current, ownerSessionId });
		if (recovered.ok) {
			input.store.publishLifecycleCoordinatorSnapshot(recovered.agent);
			return;
		}
		if (recovered.error === "lease_held") {
			const retry = setTimeout(
				() => {
					recoveryTimers.delete(agent.id);
					scheduleSpawnedAgentRecovery(input, agent, recoveryTimers);
				},
				CHILD_DISPATCH_RESERVATION_MS + 1,
			);
			recoveryTimers.set(agent.id, retry);
		}
	}, delayMs);
	recoveryTimers.set(agent.id, timer);
}

function dispatchAttachedChildSession(
	input: AttachSessionDispatchInput,
	createAttachedSession: AttachedSessionFactory,
): Promise<AgentSnapshot> {
	return dispatchAgentSession(
		input.store,
		(dispatchInput) =>
			createAttachedSession({ ...dispatchInput, sessionPath: input.target.transcript?.path ?? "" }),
		input.target,
		input.prompt,
		input.ctx,
		input.handles,
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
	const input = {
		agentType,
		cwd: resolved.cwd || ctx.cwd,
		displayName,
		lifecycle: "waiting_for_input" as const,
		model: profile.modelMetadata,
		origin: "attached" as const,
		permission,
		transcript: { path: resolved.path, sessionId: resolved.sessionId },
	};
	if (!params.parentId) {
		return { ok: true, agent: store.spawnAgent(input).agent };
	}
	const attached = store.attachSessionAgent(params.parentId, input);
	if (attached.ok) {
		return attached;
	}
	return "parent" in attached
		? { ok: false, error: attached.error, parent: attached.parent }
		: { ok: false, error: attached.error };
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
	ctx: ExtensionContext,
	pi: ExtensionAPI | undefined,
	desktopNotifier: AgentDesktopNotifier,
	waitingDesktopNotifications: WaitingDesktopNotificationHandles,
	handles?: BackgroundSessionHandles,
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
		try {
			mirrorLifecycleRuntimeMailboxMessage(store, message, ctx);
		} catch (error) {
			console.error("Failed to mirror agent lifecycle notification into runtime mailbox:", error);
		}
	});
	const trackedDispatch = trackAgentDispatch(store, dispatches, agent, dispatch(), handles);
	void trackedDispatch.then((agent) => {
		try {
			mirrorAgentLifecycleRuntimeMailbox(store, agent, ctx);
		} catch (error) {
			console.error("Failed to mirror agent lifecycle notification into runtime mailbox:", error);
		}
	});
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
	handles?: BackgroundSessionHandles,
): Promise<AgentSnapshot> {
	const restoreGeneration = store.getRestoreGeneration();
	const trackedDispatch = dispatch.catch((error: unknown) =>
		transitionActiveAgent(
			store,
			agent,
			"failed",
			{
				error: { message: error instanceof Error ? error.message : String(error) },
			},
			restoreGeneration,
		),
	);
	dispatches.set(agent.id, trackedDispatch);
	void trackedDispatch.finally(() => {
		if (dispatches.get(agent.id) === trackedDispatch) {
			handles?.delete(agent.id);
			dispatches.delete(agent.id);
		}
	});

	return trackedDispatch;
}

async function dispatchAgentSession(
	store: MultiAgentStore,
	createChildSession: ChildAgentSessionFactory,
	initialAgent: AgentSnapshot,
	prompt: string,
	ctx: ExtensionContext,
	handles?: BackgroundSessionHandles,
): Promise<AgentSnapshot> {
	const running = rampToRunning(store, initialAgent);
	if (!running.ok) return running.agent;
	return runAgentSession(store, createChildSession, running.agent, prompt, ctx, handles);
}

async function dispatchReservedAgentSession(
	store: MultiAgentStore,
	createChildSession: ChildAgentSessionFactory,
	ownership: ReservedLifecycleCommandInput,
	coordinator: LifecycleCoordinator,
	prompt: string,
	ctx: ExtensionContext,
	handles?: BackgroundSessionHandles,
): Promise<AgentSnapshot> {
	let childSession: ChildAgentSession;
	try {
		childSession = await createChildSession({ agent: ownership.agent, ctx, prompt });
	} catch (error) {
		const runtimeError = {
			code: "runtime_spawn_failed",
			message: error instanceof Error ? error.message : String(error),
		};
		const failed = coordinator.finalizeChild({
			agent: ownership.agent,
			error: runtimeError,
			eventPayload: { error: runtimeError },
			reservation: ownership.reservation,
			terminalLifecycle: "failed",
		});
		if (!failed.ok) return ownership.agent;
		store.publishLifecycleCoordinatorSnapshot(failed.agent);
		return failed.agent;
	}
	const running = coordinator.confirmChildRuntime(ownership);
	if (!running.ok) {
		childSession.abort?.();
		childSession.dispose?.();
		return ownership.agent;
	}
	store.publishLifecycleCoordinatorSnapshot(running.agent);
	return runAgentSession(store, createChildSession, running.agent, prompt, ctx, handles, childSession, {
		coordinator,
		ownership: { agent: running.agent, reservation: ownership.reservation },
	});
}

async function runAgentSession(
	store: MultiAgentStore,
	createChildSession: ChildAgentSessionFactory,
	runningAgent: AgentSnapshot,
	prompt: string,
	ctx: ExtensionContext,
	handles?: BackgroundSessionHandles,
	createdSession?: ChildAgentSession,
	reservedRuntime?: ReservedAgentRuntime,
): Promise<AgentSnapshot> {
	const restoreGeneration = store.getRestoreGeneration();
	const running = { agent: runningAgent };
	let childSession: ChildAgentSession | undefined;
	let unregisterAbortHandler: (() => void) | undefined;
	try {
		const activeSession = createdSession ?? (await createChildSession({ agent: running.agent, ctx, prompt }));
		childSession = activeSession;
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
		const cancelled = acknowledgeCancelledRuntime(store, running.agent.id, reservedRuntime);
		if (cancelled) return cancelled;
		while (true) {
			const summary = lastAssistantText(activeSession.messages);
			const completed = transitionRunningAgent(
				store,
				running.agent,
				"completed",
				{
					result: summary ? { summary } : undefined,
				},
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
		const cancelled = acknowledgeCancelledRuntime(store, running.agent.id, reservedRuntime);
		if (cancelled) return cancelled;
		return transitionRunningAgent(
			store,
			running.agent,
			"failed",
			{
				error: { message: error instanceof Error ? error.message : String(error) },
			},
			restoreGeneration,
		);
	} finally {
		unregisterAbortHandler?.();
		handles?.delete(running.agent.id);
		childSession?.dispose?.();
	}
}

async function dispatchAgent(
	store: MultiAgentStore,
	dispatcher: ChildAgentDispatcher,
	initialAgent: AgentSnapshot,
	prompt: string,
	ctx: ExtensionContext,
): Promise<AgentSnapshot> {
	const running = rampToRunning(store, initialAgent);
	if (!running.ok) return running.agent;
	return runAgentDispatcher(store, dispatcher, running.agent, prompt, ctx);
}

async function dispatchReservedAgent(
	store: MultiAgentStore,
	dispatcher: ChildAgentDispatcher,
	ownership: ReservedLifecycleCommandInput,
	coordinator: LifecycleCoordinator,
	prompt: string,
	ctx: ExtensionContext,
): Promise<AgentSnapshot> {
	const running = coordinator.confirmChildRuntime(ownership);
	if (!running.ok) return ownership.agent;
	store.publishLifecycleCoordinatorSnapshot(running.agent);
	return runAgentDispatcher(store, dispatcher, running.agent, prompt, ctx, {
		coordinator,
		ownership: { agent: running.agent, reservation: ownership.reservation },
	});
}

async function runAgentDispatcher(
	store: MultiAgentStore,
	dispatcher: ChildAgentDispatcher,
	runningAgent: AgentSnapshot,
	prompt: string,
	ctx: ExtensionContext,
	reservedRuntime?: ReservedAgentRuntime,
): Promise<AgentSnapshot> {
	const restoreGeneration = store.getRestoreGeneration();
	const running = { agent: runningAgent };
	try {
		const dispatchResult = await dispatcher({ agent: running.agent, ctx, prompt });
		const cancelled = acknowledgeCancelledRuntime(store, running.agent.id, reservedRuntime);
		if (cancelled) return cancelled;
		return transitionRunningAgent(
			store,
			running.agent,
			dispatchResult.lifecycle,
			{
				error: dispatchResult.error,
				result: dispatchResult.result,
			},
			restoreGeneration,
		);
	} catch (error) {
		const cancelled = acknowledgeCancelledRuntime(store, running.agent.id, reservedRuntime);
		if (cancelled) return cancelled;
		return transitionRunningAgent(
			store,
			running.agent,
			"failed",
			{
				error: { message: error instanceof Error ? error.message : String(error) },
			},
			restoreGeneration,
		);
	}
}

function acknowledgeCancelledRuntime(
	store: MultiAgentStore,
	agentId: string,
	reservedRuntime: ReservedAgentRuntime | undefined,
): AgentSnapshot | undefined {
	if (!reservedRuntime) return undefined;
	const current = store.getAgent(agentId);
	if (current?.lifecycle !== "cancelling") return undefined;
	const acknowledged = reservedRuntime.coordinator.acknowledgeCancellation({
		agent: current,
		reservation: reservedRuntime.ownership.reservation,
	});
	if (!acknowledged.ok) return current;
	store.publishLifecycleCoordinatorSnapshot(acknowledged.agent);
	return acknowledged.agent;
}

function transitionRunningAgent(
	store: MultiAgentStore,
	running: AgentSnapshot,
	lifecycle: ChildAgentDispatchResult["lifecycle"],
	metadata?: { error?: { message: string; code?: string }; result?: AgentResult },
	expectedRestoreGeneration?: number,
): AgentSnapshot {
	return transitionActiveAgent(store, running, lifecycle, metadata, expectedRestoreGeneration);
}

function transitionActiveAgent(
	store: MultiAgentStore,
	agent: AgentSnapshot,
	lifecycle: ChildAgentDispatchResult["lifecycle"],
	metadata?: { error?: { message: string; code?: string }; result?: AgentResult },
	expectedRestoreGeneration?: number,
): AgentSnapshot {
	if (expectedRestoreGeneration !== undefined && store.getRestoreGeneration() !== expectedRestoreGeneration) {
		return agent;
	}
	const current = store.getAgent(agent.id);
	if (!current) {
		return agent;
	}
	if (!isActiveLifecycle(current.lifecycle)) {
		return current;
	}
	const transitioned = store.transitionAgent(current.id, current.revision, lifecycle, metadata);
	return transitioned.ok ? transitioned.agent : (store.getAgent(agent.id) ?? agent);
}

function moveToStarting(store: MultiAgentStore, agent: AgentSnapshot): AgentSnapshot {
	if (agent.lifecycle === "starting") {
		return agent;
	}

	const starting = store.transitionAgent(agent.id, agent.revision, "starting");
	return starting.ok ? starting.agent : agent;
}

function rampToRunning(store: MultiAgentStore, initialAgent: AgentSnapshot): { ok: boolean; agent: AgentSnapshot } {
	if (initialAgent.lifecycle === "running") {
		// Reattaching a runtime to a detached running agent is not a lifecycle transition.
		return { ok: true, agent: initialAgent };
	}
	const starting = moveToStarting(store, initialAgent);
	const running = store.transitionAgent(starting.id, starting.revision, "running");
	return running.ok ? { ok: true, agent: running.agent } : { ok: false, agent: starting };
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

async function waitAgents(
	store: MultiAgentStore,
	signal: AbortSignal | undefined,
	ctx?: ExtensionContext,
): Promise<AgentToolResult<WaitAgentsToolDetails>> {
	if (ctx && isChildAgentRuntime(ctx)) {
		return errorResult(CHILD_ORCHESTRATION_UNAVAILABLE_MESSAGE, {});
	}
	if (ctx) {
		mirrorPendingLifecycleRuntimeMailboxMessages(store, ctx);
	}
	const pendingCompletion = findAgentWithPendingCompletion(store);
	if (pendingCompletion) {
		return consumeAgentCompletion(store, pendingCompletion, ctx);
	}
	const pendingFailure = findAgentWithPendingFailure(store);
	if (pendingFailure) {
		return consumeAgentFailure(store, pendingFailure, ctx);
	}

	const activeAgents = store.listActiveAgents();
	if (activeAgents.length === 0) {
		return emptyResult();
	}

	const agent = await waitForAnyTerminalAgent(store, activeAgents, signal);
	if (!agent) {
		return errorResult("Wait cancelled.", {});
	}
	if (agent.lifecycle !== "completed") {
		if (agent.lifecycle === "failed" && store.listPendingLifecycleNotificationsForAgent(agent.id, "failed").length > 0) {
			return consumeAgentFailure(store, agent, ctx);
		}
		return result(formatAgentStatus(agent), {});
	}
	return consumeAgentCompletion(store, agent, ctx);
}

function findAgentWithPendingCompletion(store: MultiAgentStore): AgentSnapshot | undefined {
	return store.listAgents().find(
		(agent) =>
			agent.lifecycle === "completed" &&
			store.listPendingLifecycleNotificationsForAgent(agent.id, "completed").length > 0,
	);
}

function consumeAgentCompletion(
	store: MultiAgentStore,
	agent: AgentSnapshot,
	ctx: ExtensionContext | undefined,
): AgentToolResult<WaitAgentsToolDetails> {
	return consumeAgentTerminalNotification(store, agent, ctx);
}

function findAgentWithPendingTerminalNotification(store: MultiAgentStore): AgentSnapshot | undefined {
	return store.listAgents().find(
		(agent) =>
			(agent.lifecycle === "completed" || agent.lifecycle === "failed") &&
			store.listPendingLifecycleNotificationsForAgent(agent.id, agent.lifecycle).length > 0,
	);
}

function consumeAgentTerminalNotification(
	store: MultiAgentStore,
	agent: AgentSnapshot,
	ctx: ExtensionContext | undefined,
): AgentToolResult<WaitAgentsToolDetails> {
	const [completionMessage] = store.consumeCompletionNotificationsForAgent(agent.id);
	if (completionMessage) {
		consumeRuntimeLifecycleNotification(ctx, store, completionMessage.id);
		const body = completionMessage.body ?? formatAgentStatus(agent);
		return result(body, { agent, message: completionMessage });
	}
	return result(formatWaitAgentsCompletion(agent), {});
}

function consumeAgentFailure(
	store: MultiAgentStore,
	agent: AgentSnapshot,
	ctx: ExtensionContext | undefined,
): AgentToolResult<WaitAgentsToolDetails> {
	const [failureMessage] = store.consumeFailureNotificationsForAgent(agent.id);
	if (failureMessage) {
		consumeRuntimeLifecycleNotification(ctx, store, failureMessage.id);
		const body = failureMessage.body ?? formatAgentStatus(agent);
		return result(body, { agent, message: failureMessage });
	}
	return result(formatAgentStatus(agent), {});
}

async function waitForAnyTerminalAgent(
	store: MultiAgentStore,
	activeAgents: AgentSnapshot[],
	signal: AbortSignal | undefined,
): Promise<AgentSnapshot | undefined> {
	if (signal?.aborted) {
		return undefined;
	}
	const trackedAgentIds = new Set(activeAgents.map((agent) => agent.id));

	return new Promise((resolve) => {
		let settled = false;
		let unsubscribe = () => {};
		const finish = (agent: AgentSnapshot | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			unsubscribe();
			signal?.removeEventListener("abort", onAbort);
			resolve(agent);
		};
		const onAbort = () => finish(undefined);
		unsubscribe = store.subscribeAgentTransitions((_previous, current) => {
			if (trackedAgentIds.has(current.id) && !isActiveLifecycle(current.lifecycle)) {
				finish(current);
			}
		});
		signal?.addEventListener("abort", onAbort, { once: true });

		const terminalAgent = findFirstTerminalAgent(store, activeAgents);
		if (terminalAgent) {
			finish(terminalAgent);
		}
	});
}

function findFirstTerminalAgent(store: MultiAgentStore, agents: AgentSnapshot[]): AgentSnapshot | undefined {
	return agents
		.map((agent) => store.getAgent(agent.id))
		.find((agent) => agent !== undefined && !isActiveLifecycle(agent.lifecycle));
}

function isInFlightLifecycle(lifecycle: AgentSnapshot["lifecycle"]): boolean {
	return isActiveLifecycle(lifecycle) && lifecycle !== "queued" && lifecycle !== "waiting_for_input";
}

function consumeRuntimeLifecycleNotification(
	ctx: ExtensionContext | undefined,
	store: MultiAgentStore,
	messageId: string,
): void {
	const controlDbPath = ctx?.controlDbPath;
	const persistence = store.getPersistenceTarget();
	if (!controlDbPath || !persistence || persistence.controlDbPath !== controlDbPath) {
		return;
	}
	consumeRuntimeMailboxMessageByStoreRef(controlDbPath, { messageId, sessionPath: persistence.sessionPath });
}

function findAgentWithPendingFailure(store: MultiAgentStore): AgentSnapshot | undefined {
	return store.listAgents().find(
		(agent) =>
			agent.lifecycle === "failed" &&
			store.listPendingLifecycleNotificationsForAgent(agent.id, "failed").length > 0,
	);
}

function formatWaitAgentsCompletion(agent: AgentSnapshot): string {
	const summary = agent.result?.summary?.trim();
	return summary ? `${agent.displayName} completed: ${summary}` : `${agent.displayName} completed.`;
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

async function cancelAgent(
	store: MultiAgentStore,
	runtimeHandles: MultiAgentRuntimeHandles,
	params: CancelAgentParams,
): Promise<AgentToolResult<AgentToolDetails>> {
	const current = store.getAgent(params.agentId);
	if (!current) {
		return errorResult(`Could not cancel ${params.agentId}: agent_not_found`, {
			agent: emptyAgent(params.agentId),
			reason: params.reason,
		});
	}

	const reservedRuntime = runtimeHandles.reservations.get(params.agentId);
	if (!reservedRuntime) {
		return errorResult(`Could not cancel ${params.agentId}: lifecycle reservation unavailable`, {
			agent: current,
			reason: params.reason,
		});
	}
	const cancelling = reservedRuntime.coordinator.requestCancellation({
		agent: current,
		reservation: reservedRuntime.ownership.reservation,
	});
	if (!cancelling.ok) {
		return errorResult(`Could not cancel ${params.agentId}: ${cancelling.error}`, {
			agent: current,
			reason: params.reason,
		});
	}
	store.publishLifecycleCoordinatorSnapshot(cancelling.agent);
	store.abortAgentHandle(params.agentId);
	const dispatch = runtimeHandles.dispatches.get(params.agentId);
	if (dispatch) {
		await Promise.race([
			dispatch,
			new Promise<void>((resolve) => setTimeout(resolve, CANCELLATION_SETTLEMENT_TIMEOUT_MS)),
		]);
	}
	const settled = store.getAgent(params.agentId) ?? cancelling.agent;
	return result(
		settled.lifecycle === "aborted" ? `Cancelled ${settled.displayName}.` : `Cancellation requested for ${settled.displayName}.`,
		{ agent: settled, reason: params.reason },
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
	const contacted = store.contactSupervisor(params.agentId, params.expectedRevision, {
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

	const steered = store.sendSteering(params.agentId, current.revision, {
		fileRefs: params.fileRefs,
		body: params.message,
		fromAgentId: senderId,
		targetCheckpoint: params.targetCheckpoint as SteeringCheckpoint | undefined,
	});
	if (!steered.ok) {
		return errorResult(`Could not steer ${params.agentId}: ${steered.error}`, {
			agent: "current" in steered ? steered.current : emptyAgent(params.agentId),
			message: emptyMessage(params.agentId, params.message),
		});
	}

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

function mirrorPendingLifecycleRuntimeMailboxMessages(store: MultiAgentStore, ctx: ExtensionContext): void {
	for (const agent of store.listAgents()) {
		if (!isRuntimeMirroredLifecycle(agent.lifecycle)) continue;
		for (const message of store.listPendingLifecycleNotificationsForAgent(agent.id, agent.lifecycle)) {
			mirrorLifecycleRuntimeMailboxMessage(store, message, ctx);
		}
	}
}

function mirrorAgentLifecycleRuntimeMailbox(store: MultiAgentStore, agent: AgentSnapshot, ctx: ExtensionContext): void {
	if (!isRuntimeMirroredLifecycle(agent.lifecycle)) {
		return;
	}
	const notification = store.listPendingLifecycleNotificationsForAgent(agent.id, agent.lifecycle)[0];
	if (!notification) {
		return;
	}
	mirrorLifecycleRuntimeMailboxMessage(store, notification, ctx);
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
	const currentSessionId = ctx.sessionManager.getSessionId();
	const senderSessionId = agent?.origin === "attached" ? (agent.transcript?.sessionId ?? currentSessionId) : currentSessionId;
	enqueueRuntimeMailboxMessage(ctx.controlDbPath, {
		kind: notification.kind,
		recipient: { agentId: null, sessionId: currentSessionId },
		sender: {
			agentId: notification.fromAgentId,
			sessionId: senderSessionId,
		},
		storeRef,
	});
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
	const reservations = runtimeHandles.reservations;
	const waitingDesktopNotifications: WaitingDesktopNotificationHandles = new Map();
	const recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const backgroundDispatch = {
		createChildSession,
		dispatcher,
		dispatches: activeDispatches,
		handles: backgroundSessions,
		reservations,
		store,
	};
	let unsubscribeRuntimeLifecycleMirror: (() => void) | undefined;

	pi.on?.("session_start", async (_event, ctx) => {
		unsubscribeRuntimeLifecycleMirror?.();
		unsubscribeRuntimeLifecycleMirror = store.subscribeLifecycleNotifications((message) => {
			try {
				mirrorLifecycleRuntimeMailboxMessage(store, message, ctx);
			} catch (error) {
				console.error("Failed to mirror agent lifecycle notification into runtime mailbox:", error);
			}
		});
		try {
			mirrorPendingLifecycleRuntimeMailboxMessages(store, ctx);
		} catch (error) {
			console.error("Failed to retry pending agent lifecycle notifications:", error);
		}
		recoverDetachedAgents({
			createAttachedSession,
			ctx,
			desktopNotifier,
			dispatcher,
			dispatches: activeDispatches,
			handles: backgroundSessions,
			pi,
			store,
			waitingDesktopNotifications,
		}, recoveryTimers);
	});
	pi.on?.("session_shutdown", async (event) => {
		if (event.reason === "reload") {
			return;
		}
		unsubscribeRuntimeLifecycleMirror?.();
		unsubscribeRuntimeLifecycleMirror = undefined;
		for (const timer of recoveryTimers.values()) clearTimeout(timer);
		recoveryTimers.clear();
		// Abort-induced dispatch rejections must not persist agents as failed;
		// the last snapshot keeps them active so a later resume can recover them.
		store.invalidateInFlightDispatches();
		for (const agentId of backgroundSessions.keys()) {
			store.abortAgentHandle(agentId);
		}
		for (const agentId of waitingDesktopNotifications.keys()) {
			closeWaitingDesktopNotification(agentId, waitingDesktopNotifications);
		}
		backgroundSessions.clear();
		activeDispatches.clear();
	});

	pi.registerCommand("bg", {
		description: "Run a prompt as a background agent job.",
		handler: async (args, ctx) => backgroundCommand(backgroundDispatch, args, ctx),
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
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
				spawnAgent(
					store,
					createChildSession,
					dispatcher,
					activeDispatches,
					reservations,
					params,
					ctx,
					desktopNotifier,
					waitingDesktopNotifications,
					pi,
					backgroundSessions,
				),
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
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
				attachSessionAgent({
					createAttachedSession,
					ctx,
					desktopNotifier,
					dispatcher,
					dispatches: activeDispatches,
					handles: backgroundSessions,
					params,
					pi,
					store,
					waitingDesktopNotifications,
				}),
		}),
	);

	pi.registerTool(
		defineTool({
			name: "wait_agents",
			label: "Wait Agents",
			description: "Wait until any active agent reaches a terminal state and consume that agent's completion notification.",
			approvalRequired: false,
			parameters: waitAgentsSchema,
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
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
			execute: async (_toolCallId, params) => cancelAgent(store, runtimeHandles, params),
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
