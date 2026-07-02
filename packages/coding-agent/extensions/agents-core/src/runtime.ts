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
import { sendDesktopNotification, type DesktopNotification, type DesktopNotifier } from "../../../src/core/desktop-notification.ts";
import {
	type AgentArtifact,
	type AgentLifecycleState,
	type AgentMailboxMessage,
	type AgentResult,
	type AgentSnapshot,
	type ContactSupervisorInput,
	formatInactiveAgentSelectionMessage,
	isActiveLifecycle,
	type MailboxMessageCommandResult,
	type MultiAgentProjectionSnapshot,
	MultiAgentStore,
	type RecordAgentArtifactInput,
	type SendMailboxMessageInput,
	type SteeringCheckpoint,
} from "../../../src/core/multi-agent-store.ts";
import { findExactModelReferenceMatch } from "../../../src/core/model-resolver.ts";
import {
	enqueueRuntimeMailboxMessage,
	readSessionMetadata,
	type RuntimeMailboxAddress,
} from "../../../src/core/session-control-db.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import type { CreateAgentSessionOptions } from "../../../src/core/sdk.ts";

const checkpointSchema = Type.Union([
	Type.Literal("next_model_call"),
	Type.Literal("after_tool_result"),
	Type.Literal("when_waiting"),
]);

const artifactReferenceSchema = Type.Object({
	id: Type.Optional(Type.String()),
	label: Type.Optional(Type.String()),
	path: Type.Optional(Type.String()),
});

const artifactKindSchema = Type.Union([
	Type.Literal("summary"),
	Type.Literal("diff"),
	Type.Literal("log"),
	Type.Literal("finding"),
	Type.Literal("transcript"),
	Type.Literal("file"),
]);

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

const waitAgentSchema = Type.Object({
	agentId: Type.String(),
	includeDescendants: Type.Optional(Type.Boolean()),
	includePendingMessages: Type.Optional(Type.Boolean()),
});

const cancelAgentSchema = Type.Object({
	agentId: Type.String(),
	expectedRevision: Type.Number(),
	reason: Type.Optional(Type.String()),
});

const steerAgentSchema = Type.Object({
	agentId: Type.String(),
	artifactRefs: Type.Optional(Type.Array(artifactReferenceSchema)),
	expectedRevision: Type.Number(),
	message: Type.String(),
	fromAgentId: Type.Optional(Type.String()),
	targetCheckpoint: Type.Optional(checkpointSchema),
});

const contactSupervisorSchema = Type.Object({
	agentId: Type.String(),
	artifactIds: Type.Optional(Type.Array(Type.String())),
	artifactRefs: Type.Optional(Type.Array(artifactReferenceSchema)),
	expectedRevision: Type.Number(),
	message: Type.String(),
	threadId: Type.Optional(Type.String()),
});

const agentViewerSchema = Type.Object({});

const agentsMailboxSchema = Type.Object({
	agentId: Type.Optional(Type.String()),
});

const sendAgentMessageSchema = Type.Object({
	artifactIds: Type.Optional(Type.Array(Type.String())),
	artifactRefs: Type.Optional(Type.Array(artifactReferenceSchema)),
	message: Type.String(),
	threadId: Type.Optional(Type.String()),
	toAgentId: Type.String(),
	toSessionId: Type.Optional(Type.String()),
});

const agentArtifactsSchema = Type.Object({
	agentId: Type.Optional(Type.String()),
	inlinePreview: Type.Optional(Type.String()),
	kind: Type.Optional(artifactKindSchema),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	path: Type.Optional(Type.String()),
	title: Type.Optional(Type.String()),
});

type SpawnAgentParams = Static<typeof spawnAgentSchema>;
type ListAgentsParams = Static<typeof listAgentsSchema>;
type WaitAgentParams = Static<typeof waitAgentSchema>;
type CancelAgentParams = Static<typeof cancelAgentSchema>;
type SteerAgentParams = Static<typeof steerAgentSchema>;
type ContactSupervisorParams = Static<typeof contactSupervisorSchema>;
type AgentsMailboxParams = Static<typeof agentsMailboxSchema>;
type SendAgentMessageParams = Static<typeof sendAgentMessageSchema>;
type AgentArtifactsParams = Static<typeof agentArtifactsSchema>;

type ChildSessionModel = CreateAgentSessionOptions["model"];

type ResolvedAgentProfile = {
	model?: ChildSessionModel;
	modelMetadata?: AgentSnapshot["model"];
	thinkingLevel?: ThinkingLevel;
};

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);
const MAIN_THREAD_AGENT_ID = "main";
const MESSAGE_CONTENT_LIMIT = 2000;
const WAIT_AGENT_POLL_INTERVAL_MS = 25;

export type AgentDesktopNotification = DesktopNotification;

export type AgentDesktopNotifier = DesktopNotifier;

export interface MultiAgentExtensionOptions {
	createChildSession?: ChildAgentSessionFactory;
	desktopNotifier?: AgentDesktopNotifier;
	dispatcher?: ChildAgentDispatcher;
	selectAgentView?: (agentId: string) => boolean | undefined;
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
	messages: AgentMessage[];
	prompt(text: string): Promise<void>;
	transcript?: AgentSnapshot["transcript"];
}

export type ChildAgentSessionFactory = (input: ChildAgentDispatchInput) => Promise<ChildAgentSession>;

export interface ProductionChildAgentSessionFactoryOptions {
	agentDir?: string;
	createSession: (options: CreateAgentSessionOptions) => Promise<{ session: ChildAgentSession }>;
	createSessionManager: (
		cwd: string,
		sessionDir: string | undefined,
		options: { parentSession: string; isSubagent?: boolean; subagentName?: string },
	) => NonNullable<CreateAgentSessionOptions["sessionManager"]>;
	extensionFactories?: ExtensionFactory[] | (() => ExtensionFactory[]);
	sessionDir?: string;
}

export interface WaitWorkflowOptions {
	includeDescendants?: boolean;
	includePendingMessages?: boolean;
}

export interface WorkflowWaitResult {
	agent: AgentSnapshot;
	descendants?: AgentSnapshot[];
	pendingMessages?: AgentMailboxMessage[];
	terminal: boolean;
}

export interface MultiAgentWorkflowOperations {
	contactSupervisor(
		agentId: string,
		expectedRevision: number,
		input: ContactSupervisorInput,
	): ReturnType<MultiAgentStore["contactSupervisor"]>;
	recordArtifact(input: RecordAgentArtifactInput): AgentArtifact;
	sendAgentMessage(
		agentId: string,
		expectedRevision: number,
		input: SendMailboxMessageInput,
	): MailboxMessageCommandResult;
	spawnAgent(input: Parameters<MultiAgentStore["spawnAgent"]>[0]): ReturnType<MultiAgentStore["spawnAgent"]>;
	waitAgent(agentId: string, options?: WaitWorkflowOptions): WorkflowWaitResult | undefined;
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

interface AgentViewerToolDetails {
	commands: AgentViewerCommand[];
	projection: MultiAgentProjectionSnapshot;
	statuses: AgentViewerStatus[];
	transcripts: AgentViewerTranscript[];
	tree: AgentViewerTreeNode[];
}

interface AgentViewerTreeNode {
	agentId: string;
	children: string[];
	parentId?: string;
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
	command: "stop" | "resume" | "steer";
	tool: "cancel_agent" | "wait_agent" | "steer_agent";
}

interface AgentsMailboxToolDetails {
	acknowledgements: AgentMailboxMessage[];
	inbox: AgentMailboxMessage[];
	outbox: AgentMailboxMessage[];
	pendingCount: number;
}

interface SendAgentMessageToolDetails {
	agent: AgentSnapshot;
	message: AgentMailboxMessage;
}

interface AgentArtifactsToolDetails {
	artifact?: AgentArtifact;
	artifacts?: AgentArtifact[];
}

type BackgroundSessionHandles = Map<string, ChildAgentSession>;
type ActiveAgentDispatches = Map<string, Promise<AgentSnapshot>>;

interface BackgroundDispatchContext {
	createChildSession: ChildAgentSessionFactory | undefined;
	dispatcher: ChildAgentDispatcher | undefined;
	dispatches: ActiveAgentDispatches;
	handles: BackgroundSessionHandles;
	store: MultiAgentStore;
}

function result<TDetails extends Record<string, unknown>>(text: string, details: TDetails): AgentToolResult<TDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
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

function startBackgroundDispatch(
	background: BackgroundDispatchContext,
	agent: AgentSnapshot,
	prompt: string,
	ctx: ExtensionCommandContext,
): AgentSnapshot {
	if (background.createChildSession) {
		const promise = trackAgentDispatch(
			background.store,
			background.dispatches,
			agent,
			dispatchAgentSession(background.store, background.createChildSession, agent, prompt, ctx, (childSession) => {
				background.handles.set(agent.id, childSession);
			}),
		);
		notifyBackgroundDispatch(promise, background.handles, ctx);
		return background.store.getAgent(agent.id) ?? agent;
	}

	if (background.dispatcher) {
		const promise = trackAgentDispatch(
			background.store,
			background.dispatches,
			agent,
			dispatchAgent(background.store, background.dispatcher, agent, prompt, ctx),
		);
		notifyBackgroundDispatch(promise, background.handles, ctx);
		return background.store.getAgent(agent.id) ?? agent;
	}

	return agent;
}

function backgroundCommand(background: BackgroundDispatchContext, args: string, ctx: ExtensionCommandContext): void {
	const prompt = args.trim();
	if (!prompt) {
		ctx.ui.notify("Usage: /bg <prompt>", "error");
		return;
	}

	const spawned = background.store.spawnAgent({
		agentType: "background",
		cwd: ctx.cwd,
		displayName: "Background Job",
		permission: { narrowed: true, policy: "on-request" },
	});
	const agent = startBackgroundDispatch(background, spawned.agent, prompt, ctx);
	ctx.ui.setEditorText("");
	ctx.ui.notify(`Background job ${agent.id} started. Use /jobs or wait_agent to inspect it.`, "info");
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
	return typeof extensionFactories === "function" ? extensionFactories() : extensionFactories;
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
	return async ({ agent, ctx }) => {
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
			excludeTools: ["spawn_agent"],
			extensionFactories: resolveChildExtensionFactories(options.extensionFactories),
			model: profile.model ?? ctx.model,
			modelRegistry: ctx.modelRegistry,
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
		recordArtifact: (input) => store.recordArtifact(input),
		sendAgentMessage: (agentId, expectedRevision, input) =>
			store.sendMailboxMessage(agentId, expectedRevision, input),
		spawnAgent: (input) => store.spawnAgent(input),
		waitAgent: (agentId, options = {}) => {
			const agent = store.getAgent(agentId);
			if (!agent) {
				return undefined;
			}
			store.consumeCompletionNotificationsForAgent(agent.id);

			const result: WorkflowWaitResult = {
				agent,
				terminal: !isActiveLifecycle(agent.lifecycle),
			};
			if (options.includeDescendants) {
				result.descendants = store.listDescendants(agent.id);
			}
			if (options.includePendingMessages) {
				result.pendingMessages = store
					.listMailboxMessages()
					.filter((message) => message.toAgentId === agent.id && message.status === "pending");
			}

			return result;
		},
	};
}

export function createHostrunMultiAgentRequestHandler(
	options: MultiAgentExtensionOptions,
): HostrunMultiAgentRequestHandler {
	const store = resolveMultiAgentStore(options);
	const activeDispatches: ActiveAgentDispatches = new Map();
	const desktopNotifier = options.desktopNotifier ?? sendDesktopNotification;

	return async (request, ctx, signal) => {
		if (request.method === "agents.spawn") {
			const result = await spawnAgent(
				store,
				options.createChildSession,
				options.dispatcher,
				activeDispatches,
				request.params as SpawnAgentParams,
				ctx,
				desktopNotifier,
			);
			return result.details;
		}

		if (request.method === "agents.wait") {
			const result = await waitAgent(store, activeDispatches, normalizeWaitAgentParams(request.params), signal);
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

function normalizeWaitAgentParams(params: unknown): WaitAgentParams {
	if (typeof params === "string") {
		if (!params.trim()) {
			throw new Error("pi.agents.wait requires a non-empty agentId");
		}
		return { agentId: params };
	}
	if (!params || typeof params !== "object") {
		throw new Error("pi.agents.wait requires an agent id string or { agentId } object");
	}
	const agentId = (params as { agentId?: unknown }).agentId;
	if (typeof agentId !== "string" || !agentId.trim()) {
		throw new Error("pi.agents.wait requires a non-empty agentId");
	}
	return {
		agentId,
		includeDescendants: (params as { includeDescendants?: boolean }).includeDescendants,
		includePendingMessages: (params as { includePendingMessages?: boolean }).includePendingMessages,
	};
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
	dispatcher: ChildAgentDispatcher | undefined,
	dispatches: ActiveAgentDispatches,
	params: SpawnAgentParams,
	ctx: ExtensionContext,
	desktopNotifier: AgentDesktopNotifier,
	pi?: ExtensionAPI,
	handles?: BackgroundSessionHandles,
): Promise<AgentToolResult<AgentToolDetails>> {
	const displayName = params.displayName?.trim() || params.agentType?.trim() || "Agent";
	const agentType = params.agentType?.trim() || "default";
	const profile = resolveConfiguredAgentProfile(agentType, ctx);
	const spawned = store.spawnAgent({
		agentType,
		cwd: ctx.cwd,
		displayName,
		lifecycle: params.lifecycle,
		model: profile.modelMetadata,
		parentId: params.parentId,
		permission: { narrowed: true, policy: "on-request" },
	});

	if (createChildSession) {
		const agent = startToolDispatch(
			store,
			dispatches,
			spawned.agent,
			() =>
				dispatchAgentSession(store, createChildSession, spawned.agent, params.prompt, ctx, (childSession) => {
					handles?.set(spawned.agent.id, childSession);
				}),
			ctx,
			pi,
			desktopNotifier,
			handles,
		);
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
			spawned.agent,
			() => dispatchAgent(store, dispatcher, spawned.agent, params.prompt, ctx),
			ctx,
			pi,
			desktopNotifier,
		);
		return result(`Spawned ${agent.displayName} (${agent.id})`, {
			agent,
			dispatched: true,
			prompt: params.prompt,
		});
	}

	return result(`Spawned ${spawned.agent.displayName} (${spawned.agent.id})`, {
		agent: spawned.agent,
		dispatched: false,
		prompt: params.prompt,
	});
}

function startToolDispatch(
	store: MultiAgentStore,
	dispatches: ActiveAgentDispatches,
	agent: AgentSnapshot,
	dispatch: () => Promise<AgentSnapshot>,
	ctx: ExtensionContext,
	pi: ExtensionAPI | undefined,
	desktopNotifier: AgentDesktopNotifier,
	handles?: BackgroundSessionHandles,
): AgentSnapshot {
	const unsubscribeLifecycleNotifications = store.subscribeLifecycleNotifications((message) => {
		if (message.fromAgentId !== agent.id) {
			return;
		}
		notifyWaitingAgent(message, desktopNotifier);
		try {
			mirrorLifecycleRuntimeMailboxMessage(store, message, ctx);
			wakeIdleParentMailbox(store, pi, ctx);
		} catch (error) {
			console.error("Failed to mirror agent lifecycle notification into runtime mailbox:", error);
		}
	});
	const trackedDispatch = trackAgentDispatch(store, dispatches, agent, dispatch());
	if (handles) {
		void trackedDispatch.finally(() => handles.delete(agent.id));
	}
	void trackedDispatch.then((agent) => {
		try {
			mirrorAgentLifecycleRuntimeMailbox(store, agent, ctx);
		} catch (error) {
			console.error("Failed to mirror agent lifecycle notification into runtime mailbox:", error);
		}
	});
	void trackedDispatch.finally(() => {
		unsubscribeLifecycleNotifications();
		wakeIdleParentMailbox(store, pi, ctx);
	});

	return store.getAgent(agent.id) ?? agent;
}

function wakeIdleParentMailbox(store: MultiAgentStore, pi: ExtensionAPI | undefined, ctx: ExtensionContext): void {
	if (ctx.controlDbPath) {
		return;
	}
	const canReadIdleState = typeof ctx.isIdle === "function";
	if (!pi || !canReadIdleState || !ctx.isIdle()) {
		return;
	}
	drainParentMailboxAtAgentEnd(store, pi, ctx);
}

function trackAgentDispatch(
	store: MultiAgentStore,
	dispatches: ActiveAgentDispatches,
	agent: AgentSnapshot,
	dispatch: Promise<AgentSnapshot>,
): Promise<AgentSnapshot> {
	const trackedDispatch = dispatch.catch((error: unknown) =>
		transitionActiveAgent(store, agent, "failed", {
			error: { message: error instanceof Error ? error.message : String(error) },
		}),
	);
	dispatches.set(agent.id, trackedDispatch);
	void trackedDispatch.finally(() => {
		dispatches.delete(agent.id);
	});

	return trackedDispatch;
}

async function dispatchAgentSession(
	store: MultiAgentStore,
	createChildSession: ChildAgentSessionFactory,
	initialAgent: AgentSnapshot,
	prompt: string,
	ctx: ExtensionContext,
	onChildSession?: (childSession: ChildAgentSession) => void,
): Promise<AgentSnapshot> {
	const starting = moveToStarting(store, initialAgent);
	const running = store.transitionAgent(starting.id, starting.revision, "running");
	if (!running.ok) {
		return starting;
	}

	try {
		const childSession = await createChildSession({ agent: running.agent, ctx, prompt });
		if (childSession.transcript) {
			store.updateAgentTranscript(running.agent.id, childSession.transcript);
		}
		onChildSession?.(childSession);
		await childSession.prompt(prompt);
		const summary = lastAssistantText(childSession.messages);
		return transitionRunningAgent(store, running.agent, "completed", {
			result: summary ? { summary } : undefined,
		});
	} catch (error) {
		return transitionRunningAgent(store, running.agent, "failed", {
			error: { message: error instanceof Error ? error.message : String(error) },
		});
	}
}

async function dispatchAgent(
	store: MultiAgentStore,
	dispatcher: ChildAgentDispatcher,
	initialAgent: AgentSnapshot,
	prompt: string,
	ctx: ExtensionContext,
): Promise<AgentSnapshot> {
	const starting = moveToStarting(store, initialAgent);
	const running = store.transitionAgent(starting.id, starting.revision, "running");
	if (!running.ok) {
		return starting;
	}

	try {
		const dispatchResult = await dispatcher({ agent: running.agent, ctx, prompt });
		return transitionRunningAgent(store, running.agent, dispatchResult.lifecycle, {
			error: dispatchResult.error,
			result: dispatchResult.result,
		});
	} catch (error) {
		return transitionRunningAgent(store, running.agent, "failed", {
			error: { message: error instanceof Error ? error.message : String(error) },
		});
	}
}

function transitionRunningAgent(
	store: MultiAgentStore,
	running: AgentSnapshot,
	lifecycle: ChildAgentDispatchResult["lifecycle"],
	metadata?: { error?: { message: string; code?: string }; result?: AgentResult },
): AgentSnapshot {
	return transitionActiveAgent(store, running, lifecycle, metadata);
}

function transitionActiveAgent(
	store: MultiAgentStore,
	agent: AgentSnapshot,
	lifecycle: ChildAgentDispatchResult["lifecycle"],
	metadata?: { error?: { message: string; code?: string }; result?: AgentResult },
): AgentSnapshot {
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

function listAgents(store: MultiAgentStore, params: ListAgentsParams): AgentToolResult<AgentListToolDetails> {
	const agents = listMatchingAgents(store, params);

	return result(`Found ${agents.length} agent${agents.length === 1 ? "" : "s"}.`, {
		activeCount: store.getActiveAgentCount(),
		agents,
	});
}

function listMatchingAgents(store: MultiAgentStore, params: ListAgentsParams): AgentSnapshot[] {
	const agents = params.parentId ? store.listDescendants(params.parentId) : store.listAgents();
	return params.activeOnly ? agents.filter((agent) => isActiveLifecycle(agent.lifecycle)) : agents;
}

function agentViewer(store: MultiAgentStore): AgentToolResult<AgentViewerToolDetails> {
	const projection = store.getProjectionSnapshot();
	return result(`Viewing ${projection.agents.length} agent${projection.agents.length === 1 ? "" : "s"}.`, {
		commands: listViewerCommands(projection.agents),
		projection,
		statuses: listViewerStatuses(projection.agents),
		transcripts: listViewerTranscripts(projection.agents),
		tree: listViewerTree(projection.agents),
	});
}

function listViewerTree(agents: AgentSnapshot[]): AgentViewerTreeNode[] {
	return agents.map((agent) => ({
		agentId: agent.id,
		children: agents.filter((candidate) => candidate.parentId === agent.id).map((child) => child.id),
		parentId: agent.parentId,
	}));
}

function listViewerStatuses(agents: AgentSnapshot[]): AgentViewerStatus[] {
	return agents.map((agent) => ({
		agentId: agent.id,
		lifecycle: agent.lifecycle,
		revision: agent.revision,
		terminal: agent.lifecycle === "completed" || agent.lifecycle === "failed" || agent.lifecycle === "aborted",
	}));
}

function listViewerTranscripts(agents: AgentSnapshot[]): AgentViewerTranscript[] {
	return agents
		.filter((agent): agent is AgentSnapshot & { transcript: NonNullable<AgentSnapshot["transcript"]> } => {
			return agent.transcript !== undefined;
		})
		.map((agent) => ({
			agentId: agent.id,
			path: agent.transcript.path,
			sessionId: agent.transcript.sessionId,
		}));
}

function listViewerCommands(agents: AgentSnapshot[]): AgentViewerCommand[] {
	return agents.flatMap((agent) => [
		{ agentId: agent.id, command: "stop", tool: "cancel_agent" },
		{ agentId: agent.id, command: "resume", tool: "wait_agent" },
		{ agentId: agent.id, command: "steer", tool: "steer_agent" },
	]);
}

function drainParentMailboxAtAgentEnd(store: MultiAgentStore, pi: ExtensionAPI, ctx: ExtensionContext): void {
	const agentId = resolveCurrentMailboxAgentId(store, ctx);
	if (!agentId) {
		return;
	}

	for (const message of store.listPendingMailboxMessagesForAgent(agentId)) {
		if (message.kind === "steer") {
			continue;
		}
		pi.sendUserMessage(formatParentMailboxMessage(store, message), { deliverAs: "followUp" });
		store.markMailboxMessageDelivered(message.id);
	}
}

function resolveCurrentMailboxAgentId(store: MultiAgentStore, ctx: ExtensionContext): string | undefined {
	if (!ctx.sessionManager.isSubagentSession()) {
		return MAIN_THREAD_AGENT_ID;
	}

	const sessionId = ctx.sessionManager.getSessionId();
	return store.listAgents().find((agent) => agent.transcript?.sessionId === sessionId)?.id;
}

function formatParentMailboxMessage(store: MultiAgentStore, message: AgentMailboxMessage): string {
	const sender = store.getAgent(message.fromAgentId);
	const senderLabel = sender ? `${sender.displayName} (${sender.id})` : message.fromAgentId;
	const body = message.body?.trim() || "No message body.";
	const artifactDetails = formatMailboxArtifactDetails(message);
	return [`Mailbox message from ${senderLabel}: ${body}`, ...artifactDetails].join("\n");
}

function formatMailboxArtifactDetails(message: AgentMailboxMessage): string[] {
	const artifactIds = message.artifactIds?.map((artifactId) => `- ${artifactId}`) ?? [];
	const artifactRefs = message.artifactRefs?.map(formatMailboxArtifactReference) ?? [];
	const sections: string[] = [];
	if (artifactIds.length > 0) {
		sections.push(["Artifact IDs:", ...artifactIds].join("\n"));
	}
	if (artifactRefs.length > 0) {
		sections.push(["Artifact references:", ...artifactRefs].join("\n"));
	}
	return sections;
}

function formatMailboxArtifactReference(ref: NonNullable<AgentMailboxMessage["artifactRefs"]>[number]): string {
	const label = ref.label ?? ref.id ?? ref.path ?? "artifact";
	const parts = [label, ref.id, ref.path].filter((part): part is string => Boolean(part));
	return `- ${parts.join(" — ")}`;
}

function agentsMailbox(store: MultiAgentStore, params: AgentsMailboxParams): AgentToolResult<AgentsMailboxToolDetails> {
	const messages = store.listMailboxMessages();
	const scopedMessages = params.agentId
		? messages.filter((message) => message.toAgentId === params.agentId || message.fromAgentId === params.agentId)
		: messages;
	const inbox = params.agentId
		? scopedMessages.filter((message) => message.toAgentId === params.agentId)
		: scopedMessages;
	const outbox = params.agentId
		? scopedMessages.filter((message) => message.fromAgentId === params.agentId)
		: scopedMessages;
	const acknowledgements = scopedMessages.filter((message) => message.status !== "pending");
	const pendingCount = scopedMessages.filter((message) => message.status === "pending").length;

	return result(`Mailbox has ${pendingCount} pending message${pendingCount === 1 ? "" : "s"}.`, {
		acknowledgements,
		inbox,
		outbox,
		pendingCount,
	});
}

function agentArtifacts(
	store: MultiAgentStore,
	params: AgentArtifactsParams,
): AgentToolResult<AgentArtifactsToolDetails> {
	if (params.agentId && params.kind && params.title) {
		const artifact = store.recordArtifact({
			agentId: params.agentId,
			inlinePreview: params.inlinePreview,
			kind: params.kind,
			metadata: params.metadata,
			path: params.path,
			title: params.title,
		});
		return result(`Recorded artifact ${artifact.id}.`, { artifact });
	}

	const artifacts = store.listArtifacts(params.agentId);
	return result(`Found ${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}.`, { artifacts });
}

function sendAgentMessage(
	store: MultiAgentStore,
	params: SendAgentMessageParams,
	ctx?: ExtensionContext,
): AgentToolResult<SendAgentMessageToolDetails> {
	if (params.toSessionId) {
		if (isMainRuntimeTarget(params.toAgentId)) {
			return sendMainRuntimeSessionMessage(store, params, ctx);
		}
		const targetSessionId = resolveAgentRuntimeSessionId(store, params.toAgentId);
		if (targetSessionId !== undefined && targetSessionId !== params.toSessionId) {
			return errorResult(
				`Could not send agent message to ${params.toAgentId}: target session does not match ${params.toSessionId}.`,
				{
					agent: currentMessageSenderAgent(store, ctx),
					message: emptyDirectMessage(currentMessageSenderId(store, ctx), params.toAgentId, params.message),
				},
			);
		}
	}

	const senderId = currentMessageSenderId(store, ctx);
	const sender = store.getAgent(senderId);
	const messageInput = {
		artifactIds: params.artifactIds,
		artifactRefs: params.artifactRefs,
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
		mirrorRuntimeSessionMessage(sent.message, params.toSessionId, ctx);
	} else {
		mirrorRuntimeMailboxMessage(store, sent.message, ctx);
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
): AgentToolResult<SendAgentMessageToolDetails> {
	const sender = currentMessageSenderAgent(store, ctx);
	if (!params.toSessionId) {
		return errorResult("Could not send runtime session message: target session unavailable.", {
			agent: sender,
			message: emptyDirectMessage(currentMessageSenderId(store, ctx), params.toAgentId, params.message),
		});
	}
	const message = createRuntimeSessionMessage(params, currentMessageSenderId(store, ctx));
	mirrorRuntimeSessionMessage(message, params.toSessionId, ctx);
	return result(`Sent message to session ${params.toSessionId}.`, {
		agent: sender,
		message,
	});
}

function createRuntimeSessionMessage(params: SendAgentMessageParams, senderId: string): AgentMailboxMessage {
	const timestamp = new Date().toISOString();
	return {
		artifactIds: params.artifactIds,
		artifactRefs: params.artifactRefs,
		body: params.message,
		createdAt: timestamp,
		fromAgentId: senderId,
		id: "",
		kind: "message",
		status: "pending",
		threadId: params.threadId,
		toAgentId: params.toAgentId,
		updatedAt: timestamp,
	};
}

function mirrorRuntimeSessionMessage(
	message: AgentMailboxMessage,
	toSessionId: string,
	ctx: ExtensionContext | undefined,
): void {
	if (!ctx?.controlDbPath) {
		return;
	}
	enqueueRuntimeMailboxMessage(ctx.controlDbPath, {
		artifactIds: message.artifactIds,
		artifactRefs: message.artifactRefs,
		body: message.body ?? "",
		kind: message.kind,
		recipient: { agentId: null, sessionId: toSessionId },
		sender: {
			agentId: message.fromAgentId === MAIN_THREAD_AGENT_ID ? null : message.fromAgentId,
			sessionId: ctx.sessionManager.getSessionId(),
		},
	});
}

function currentMessageSenderId(store: MultiAgentStore, ctx: ExtensionContext | undefined): string {
	if (!ctx?.sessionManager || typeof ctx.sessionManager.getSessionId !== "function") {
		return MAIN_THREAD_AGENT_ID;
	}
	const sessionId = ctx.sessionManager.getSessionId();
	return store.listAgents().find((agent) => agent.transcript?.sessionId === sessionId)?.id ?? MAIN_THREAD_AGENT_ID;
}

function currentMessageSenderAgent(store: MultiAgentStore, ctx: ExtensionContext | undefined): AgentSnapshot {
	const senderId = currentMessageSenderId(store, ctx);
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

async function waitAgent(
	store: MultiAgentStore,
	dispatches: ActiveAgentDispatches,
	params: WaitAgentParams,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<AgentToolDetails>> {
	const initialAgent = store.getAgent(params.agentId);
	if (!initialAgent) {
		return errorResult(`Agent not found: ${params.agentId}`, { agent: emptyAgent(params.agentId), terminal: true });
	}

	const dispatch = dispatches.get(initialAgent.id);
	if (dispatch && isActiveLifecycle(initialAgent.lifecycle)) {
		const aborted = await waitForDispatch(store, initialAgent.id, dispatch, signal);
		if (aborted) {
			const agent = store.getAgent(params.agentId) ?? initialAgent;
			return errorResult(`Wait cancelled for ${agent.displayName}.`, createWaitAgentDetails(store, agent, params));
		}
	}

	const agent = store.getAgent(params.agentId) ?? initialAgent;
	store.consumeCompletionNotificationsForAgent(agent.id);
	return result(formatAgentStatus(agent), createWaitAgentDetails(store, agent, params));
}

function createWaitAgentDetails(
	store: MultiAgentStore,
	agent: AgentSnapshot,
	params: WaitAgentParams,
): AgentToolDetails {
	const details: AgentToolDetails = { agent, terminal: !isActiveLifecycle(agent.lifecycle) };
	if (params.includeDescendants) {
		details.descendants = store.listDescendants(agent.id);
	}
	if (params.includePendingMessages) {
		details.pendingMessages = store
			.listMailboxMessages()
			.filter((message) => message.toAgentId === agent.id && message.status === "pending");
	}

	return details;
}

function isWaitAgentReady(agent: AgentSnapshot): boolean {
	return !isActiveLifecycle(agent.lifecycle);
}

async function waitForDispatch(
	store: MultiAgentStore,
	agentId: string,
	dispatch: Promise<AgentSnapshot>,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	if (signal?.aborted) {
		return true;
	}

	return new Promise((resolve) => {
		let settled = false;
		let pollTimer: ReturnType<typeof setTimeout> | undefined;
		const finish = (aborted: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			if (pollTimer) {
				clearTimeout(pollTimer);
			}
			signal?.removeEventListener("abort", onAbort);
			resolve(aborted);
		};
		const onAbort = () => {
			finish(true);
		};
		const pollStoreState = () => {
			const agent = store.getAgent(agentId);
			if (agent && isWaitAgentReady(agent)) {
				finish(false);
				return;
			}
			pollTimer = setTimeout(pollStoreState, WAIT_AGENT_POLL_INTERVAL_MS);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		void dispatch.finally(() => {
			finish(false);
		});
		pollStoreState();
	});
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

function cancelAgent(
	store: MultiAgentStore,
	handles: BackgroundSessionHandles | undefined,
	params: CancelAgentParams,
): AgentToolResult<AgentToolDetails> {
	const cancelled = store.transitionAgent(params.agentId, params.expectedRevision, "aborted");
	if (!cancelled.ok) {
		return errorResult(`Could not cancel ${params.agentId}: ${cancelled.error}`, {
			agent: "current" in cancelled ? cancelled.current : emptyAgent(params.agentId),
			reason: params.reason,
		});
	}
	const childSession = handles?.get(params.agentId);
	childSession?.abort?.();
	handles?.delete(params.agentId);

	return result(`Cancelled ${cancelled.agent.displayName}.`, {
		agent: cancelled.agent,
		reason: params.reason,
	});
}

function contactSupervisor(
	store: MultiAgentStore,
	params: ContactSupervisorParams,
	ctx?: ExtensionContext,
): AgentToolResult<ContactSupervisorToolDetails> {
	const contacted = store.contactSupervisor(params.agentId, params.expectedRevision, {
		artifactIds: params.artifactIds,
		artifactRefs: params.artifactRefs,
		body: params.message,
		threadId: params.threadId,
	});
	if (!contacted.ok) {
		return errorResult(`Could not contact supervisor for ${params.agentId}: ${contacted.error}`, {
			agent: "current" in contacted ? contacted.current : emptyAgent(params.agentId),
			message: emptySupervisorRequest(params.agentId, params.message),
		});
	}

	mirrorRuntimeMailboxMessage(store, contacted.message, ctx);

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
	const steered = store.sendSteering(params.agentId, params.expectedRevision, {
		artifactRefs: params.artifactRefs,
		body: params.message,
		fromAgentId: params.fromAgentId?.trim() || "supervisor",
		targetCheckpoint: params.targetCheckpoint as SteeringCheckpoint | undefined,
	});
	if (!steered.ok) {
		return errorResult(`Could not steer ${params.agentId}: ${steered.error}`, {
			agent: "current" in steered ? steered.current : emptyAgent(params.agentId),
			message: emptyMessage(params.agentId, params.message),
		});
	}

	mirrorRuntimeMailboxMessage(store, steered.message, ctx);

	return result(`Queued steering for ${steered.agent.displayName}.`, {
		agent: steered.agent,
		message: steered.message,
	});
}

function notifyWaitingAgent(message: AgentMailboxMessage, desktopNotifier: AgentDesktopNotifier): void {
	if (!isWaitingForInputNotification(message)) {
		return;
	}
	try {
		desktopNotifier({
			body: message.body ?? `${message.fromAgentId} is waiting for input.`,
			title: "Pi agent needs input",
		});
	} catch (error) {
		console.error("Failed to send agent input-needed desktop notification:", error);
	}
}

function isWaitingForInputNotification(message: AgentMailboxMessage): boolean {
	return (
		message.kind === "system" &&
		message.status === "pending" &&
		(message.threadId?.startsWith("agent-waiting-for-input:") ?? false)
	);
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

function mirrorLifecycleRuntimeMailboxMessage(
	store: MultiAgentStore,
	notification: AgentMailboxMessage,
	ctx: ExtensionContext,
): void {
	if (!ctx.controlDbPath) {
		return;
	}
	const agent = store.getAgent(notification.fromAgentId);
	enqueueRuntimeMailboxMessage(ctx.controlDbPath, {
		artifactIds: notification.artifactIds,
		artifactRefs: notification.artifactRefs,
		body: notification.body ?? "",
		kind: notification.kind,
		recipient: { agentId: null, sessionId: ctx.sessionManager.getSessionId() },
		sender: {
			agentId: notification.fromAgentId,
			sessionId: agent?.transcript?.sessionId ?? ctx.sessionManager.getSessionId(),
		},
	});
	store.markMailboxMessageDelivered(notification.id);
}

function isRuntimeMirroredLifecycle(lifecycle: AgentLifecycleState): lifecycle is "completed" | "waiting_for_input" {
	return lifecycle === "completed" || lifecycle === "waiting_for_input";
}

function mirrorRuntimeMailboxMessage(
	store: MultiAgentStore,
	message: AgentMailboxMessage,
	ctx: ExtensionContext | undefined,
): void {
	if (!ctx?.controlDbPath) {
		return;
	}
	const recipient = resolveRuntimeRecipient(store, message, ctx);
	if (!recipient) {
		return;
	}
	enqueueRuntimeMailboxMessage(ctx.controlDbPath, {
		artifactIds: message.artifactIds,
		artifactRefs: message.artifactRefs,
		body: message.body ?? "",
		kind: message.kind,
		recipient,
		sender: {
			agentId: message.fromAgentId,
			sessionId: ctx.sessionManager.getSessionId(),
		},
	});
}

function resolveRuntimeRecipient(
	store: MultiAgentStore,
	message: AgentMailboxMessage,
	ctx: ExtensionContext,
): RuntimeMailboxAddress | undefined {
	const target = store.getAgent(message.toAgentId);
	if (target?.transcript?.sessionId) {
		return { agentId: null, sessionId: target.transcript.sessionId };
	}
	if (message.toAgentId !== MAIN_THREAD_AGENT_ID && message.toAgentId !== "supervisor") {
		return { agentId: message.toAgentId, sessionId: ctx.sessionManager.getSessionId() };
	}
	const currentSessionId = ctx.sessionManager.getSessionId();
	return { agentId: null, sessionId: resolveParentRuntimeSessionId(ctx) ?? currentSessionId };
}

function resolveParentRuntimeSessionId(ctx: ExtensionContext): string | undefined {
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
	const createChildSession = options.createChildSession;
	const desktopNotifier = options.desktopNotifier ?? sendDesktopNotification;
	const dispatcher = options.dispatcher;
	const backgroundSessions: BackgroundSessionHandles = new Map();
	const activeDispatches: ActiveAgentDispatches = new Map();
	const backgroundDispatch = { createChildSession, dispatcher, dispatches: activeDispatches, handles: backgroundSessions, store };

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
					params,
					ctx,
					desktopNotifier,
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
			name: "agent_artifacts",
			label: "Agent Artifacts",
			description: "Record or list shared multi-agent artifact pointers outside mailbox events.",
			approvalRequired: false,
			parameters: agentArtifactsSchema,
			execute: async (_toolCallId, params) => agentArtifacts(store, params),
		}),
	);

	pi.registerTool(
		defineTool({
			name: "wait_agent",
			label: "Wait Agent",
			description: "Wait for a dispatched agent to finish, then read its final state.",
			approvalRequired: false,
			parameters: waitAgentSchema,
			execute: async (_toolCallId, params, signal) => waitAgent(store, activeDispatches, params, signal),
		}),
	);

	pi.registerTool(
		defineTool({
			name: "cancel_agent",
			label: "Cancel Agent",
			description: "Cancel an agent through the multi-agent store with revision checking.",
			approvalRequired: false,
			parameters: cancelAgentSchema,
			execute: async (_toolCallId, params) => cancelAgent(store, backgroundSessions, params),
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
			description: "Read a projection snapshot for agent tree/status/slot viewer surfaces.",
			approvalRequired: false,
			parameters: agentViewerSchema,
			execute: async () => agentViewer(store),
		}),
	);
}

export function registerAgentsMailboxTools(pi: ExtensionAPI, options: MultiAgentExtensionOptions = {}) {
	const store = resolveMultiAgentStore(options);

	pi.on?.("agent_end", async (_event, ctx) => {
		drainParentMailboxAtAgentEnd(store, pi, ctx);
	});

	pi.registerTool(
		defineTool({
			name: "agents_mailbox",
			label: "Agents Mailbox",
			description: "Read inbox, outbox, and acknowledgement summaries from the multi-agent mailbox.",
			approvalRequired: false,
			parameters: agentsMailboxSchema,
			execute: async (_toolCallId, params) => agentsMailbox(store, params),
		}),
	);

	pi.registerTool(
		defineTool({
			name: "send_agent_message",
			label: "Send Agent Message",
			description: "Send a sibling-safe direct mailbox message across a parent-child agent relationship.",
			approvalRequired: false,
			parameters: sendAgentMessageSchema,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => sendAgentMessage(store, params, ctx),
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
