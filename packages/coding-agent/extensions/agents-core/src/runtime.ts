import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import {
	type AgentToolResult,
	defineTool,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "../../../src/core/extensions/types.ts";
import {
	type AgentArtifact,
	type AgentLifecycleState,
	type AgentMailboxMessage,
	type AgentResult,
	type AgentSnapshot,
	type ContactSupervisorInput,
	isActiveLifecycle,
	type MailboxMessageCommandResult,
	type MultiAgentProjectionSnapshot,
	MultiAgentStore,
	type RecordAgentArtifactInput,
	type SendMailboxMessageInput,
	type SteeringCheckpoint,
} from "../../../src/core/multi-agent-store.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";

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
	expectedRevision: Type.Number(),
	fromAgentId: Type.String(),
	message: Type.String(),
	threadId: Type.Optional(Type.String()),
	toAgentId: Type.String(),
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

export interface MultiAgentExtensionOptions {
	createChildSession?: ChildAgentSessionFactory;
	dispatcher?: ChildAgentDispatcher;
	store?: MultiAgentStore;
}

export interface ChildAgentDispatchInput {
	agent: AgentSnapshot;
	ctx: ExtensionContext;
	prompt: string;
}

export interface ChildAgentDispatchResult {
	lifecycle: "completed" | "failed" | "aborted";
	error?: { message: string; code?: string };
	result?: AgentResult;
}

export type ChildAgentDispatcher = (input: ChildAgentDispatchInput) => Promise<ChildAgentDispatchResult>;

export interface ChildAgentSession {
	abort?(): void;
	messages: AgentMessage[];
	prompt(text: string): Promise<void>;
}

export type ChildAgentSessionFactory = (input: ChildAgentDispatchInput) => Promise<ChildAgentSession>;

export interface ProductionChildAgentSessionFactoryOptions {
	agentDir?: string;
	createSession?: (options: CreateAgentSessionOptions) => Promise<{ session: ChildAgentSession }>;
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

interface BackgroundDispatchContext {
	createChildSession: ChildAgentSessionFactory | undefined;
	dispatcher: ChildAgentDispatcher | undefined;
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
		const promise = dispatchAgentSession(background.store, background.createChildSession, agent, prompt, ctx, (childSession) => {
			background.handles.set(agent.id, childSession);
		});
		notifyBackgroundDispatch(promise, background.handles, ctx);
		return background.store.getAgent(agent.id) ?? agent;
	}

	if (background.dispatcher) {
		const promise = dispatchAgent(background.store, background.dispatcher, agent, prompt, ctx);
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

export function createProductionChildAgentSessionFactory(
	options: ProductionChildAgentSessionFactoryOptions = {},
): ChildAgentSessionFactory {
	const createSession = options.createSession ?? createAgentSession;

	return async ({ agent, ctx }) => {
		const parentSession = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
		const sessionDir = options.sessionDir ?? ctx.sessionManager.getSessionDir();
		const sessionManager = SessionManager.create(agent.cwd, sessionDir, { parentSession });
		const result = await createSession({
			agentDir: options.agentDir,
			cwd: agent.cwd,
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			sessionManager,
		});

		return result.session;
	};
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

async function spawnAgent(
	store: MultiAgentStore,
	createChildSession: ChildAgentSessionFactory | undefined,
	dispatcher: ChildAgentDispatcher | undefined,
	params: SpawnAgentParams,
	ctx: ExtensionContext,
): Promise<AgentToolResult<AgentToolDetails>> {
	const displayName = params.displayName?.trim() || params.agentType?.trim() || "Agent";
	const agentType = params.agentType?.trim() || "default";
	const spawned = store.spawnAgent({
		agentType,
		cwd: ctx.cwd,
		displayName,
		lifecycle: params.lifecycle,
		parentId: params.parentId,
		permission: { narrowed: true, policy: "on-request" },
	});

	if (createChildSession) {
		const dispatched = await dispatchAgentSession(store, createChildSession, spawned.agent, params.prompt, ctx);
		return result(`Spawned ${dispatched.displayName} (${dispatched.id})`, {
			agent: dispatched,
			dispatched: true,
			prompt: params.prompt,
		});
	}

	if (dispatcher) {
		const dispatched = await dispatchAgent(store, dispatcher, spawned.agent, params.prompt, ctx);
		return result(`Spawned ${dispatched.displayName} (${dispatched.id})`, {
			agent: dispatched,
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
	lifecycle: "completed" | "failed" | "aborted",
	metadata?: { error?: { message: string; code?: string }; result?: AgentResult },
): AgentSnapshot {
	const current = store.getAgent(running.id);
	if (!current) {
		return running;
	}
	if (!isActiveLifecycle(current.lifecycle)) {
		return current;
	}
	const transitioned = store.transitionAgent(current.id, current.revision, lifecycle, metadata);
	return transitioned.ok ? transitioned.agent : (store.getAgent(running.id) ?? running);
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
): AgentToolResult<SendAgentMessageToolDetails> {
	const sent = store.sendMailboxMessage(params.fromAgentId, params.expectedRevision, {
		artifactIds: params.artifactIds,
		artifactRefs: params.artifactRefs,
		body: params.message,
		threadId: params.threadId,
		toAgentId: params.toAgentId,
	});
	if (!sent.ok) {
		return errorResult(`Could not send agent message from ${params.fromAgentId}: ${sent.error}`, {
			agent: "current" in sent ? sent.current : emptyAgent(params.fromAgentId),
			message: emptyDirectMessage(params.fromAgentId, params.toAgentId, params.message),
		});
	}

	return result(`Sent message to ${sent.message.toAgentId}.`, {
		agent: sent.agent,
		message: sent.message,
	});
}

function waitAgent(store: MultiAgentStore, params: WaitAgentParams): AgentToolResult<AgentToolDetails> {
	const agent = store.getAgent(params.agentId);
	if (!agent) {
		return errorResult(`Agent not found: ${params.agentId}`, { agent: emptyAgent(params.agentId), terminal: true });
	}

	const terminal = !isActiveLifecycle(agent.lifecycle);
	const details: AgentToolDetails = { agent, terminal };
	if (params.includeDescendants) {
		details.descendants = store.listDescendants(agent.id);
	}
	if (params.includePendingMessages) {
		details.pendingMessages = store
			.listMailboxMessages()
			.filter((message) => message.toAgentId === agent.id && message.status === "pending");
	}

	return result(formatAgentStatus(agent), details);
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
	handles?.get(params.agentId)?.abort?.();

	return result(`Cancelled ${cancelled.agent.displayName}.`, {
		agent: cancelled.agent,
		reason: params.reason,
	});
}

function contactSupervisor(
	store: MultiAgentStore,
	params: ContactSupervisorParams,
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

	return result(`Contacted supervisor for ${contacted.agent.displayName}.`, {
		agent: contacted.agent,
		message: contacted.message,
	});
}

function steerAgent(store: MultiAgentStore, params: SteerAgentParams): AgentToolResult<AgentSteerToolDetails> {
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

	return result(`Queued steering for ${steered.agent.displayName}.`, {
		agent: steered.agent,
		message: steered.message,
	});
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
	const dispatcher = options.dispatcher;
	const backgroundSessions: BackgroundSessionHandles = new Map();
	const backgroundDispatch = { createChildSession, dispatcher, handles: backgroundSessions, store };

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
			approvalRequired: false,
			parameters: spawnAgentSchema,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
				spawnAgent(store, createChildSession, dispatcher, params, ctx),
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
			description: "Read the current agent state and whether it is terminal.",
			approvalRequired: false,
			parameters: waitAgentSchema,
			execute: async (_toolCallId, params) => waitAgent(store, params),
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
			execute: async (_toolCallId, params) => steerAgent(store, params),
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
			execute: async (_toolCallId, params) => sendAgentMessage(store, params),
		}),
	);

	pi.registerTool(
		defineTool({
			name: "contact_supervisor",
			label: "Contact Supervisor",
			description: "Send a child-agent mailbox request to its direct supervisor.",
			approvalRequired: false,
			parameters: contactSupervisorSchema,
			execute: async (_toolCallId, params) => contactSupervisor(store, params),
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
