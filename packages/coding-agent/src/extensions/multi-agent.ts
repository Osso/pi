import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import {
	type AgentToolResult,
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "../core/extensions/types.ts";
import {
	type AgentLifecycleState,
	type AgentMailboxMessage,
	type AgentResult,
	type AgentSnapshot,
	isActiveLifecycle,
	MultiAgentStore,
	type SteeringCheckpoint,
} from "../core/multi-agent-store.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../core/sdk.ts";
import { SessionManager } from "../core/session-manager.ts";

const checkpointSchema = Type.Union([
	Type.Literal("next_model_call"),
	Type.Literal("after_tool_result"),
	Type.Literal("when_waiting"),
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
});

const cancelAgentSchema = Type.Object({
	agentId: Type.String(),
	expectedRevision: Type.Number(),
	reason: Type.Optional(Type.String()),
});

const steerAgentSchema = Type.Object({
	agentId: Type.String(),
	expectedRevision: Type.Number(),
	message: Type.String(),
	fromAgentId: Type.Optional(Type.String()),
	targetCheckpoint: Type.Optional(checkpointSchema),
});

const contactSupervisorSchema = Type.Object({
	agentId: Type.String(),
	artifactIds: Type.Optional(Type.Array(Type.String())),
	expectedRevision: Type.Number(),
	message: Type.String(),
	threadId: Type.Optional(Type.String()),
});

type SpawnAgentParams = Static<typeof spawnAgentSchema>;
type ListAgentsParams = Static<typeof listAgentsSchema>;
type WaitAgentParams = Static<typeof waitAgentSchema>;
type CancelAgentParams = Static<typeof cancelAgentSchema>;
type SteerAgentParams = Static<typeof steerAgentSchema>;
type ContactSupervisorParams = Static<typeof contactSupervisorSchema>;

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
	messages: AgentMessage[];
	prompt(text: string): Promise<void>;
}

export type ChildAgentSessionFactory = (input: ChildAgentDispatchInput) => Promise<ChildAgentSession>;

export interface ProductionChildAgentSessionFactoryOptions {
	agentDir?: string;
	createSession?: (options: CreateAgentSessionOptions) => Promise<{ session: ChildAgentSession }>;
	sessionDir?: string;
}

interface AgentToolDetails {
	agent: AgentSnapshot;
	dispatched?: boolean;
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

export function createProductionChildAgentSessionFactory(
	options: ProductionChildAgentSessionFactoryOptions = {},
): ChildAgentSessionFactory {
	const createSession = options.createSession ?? createAgentSession;

	return async ({ agent, ctx }) => {
		const parentSession = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
		const sessionManager = SessionManager.create(agent.cwd, options.sessionDir, { parentSession });
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
): Promise<AgentSnapshot> {
	const starting = moveToStarting(store, initialAgent);
	const running = store.transitionAgent(starting.id, starting.revision, "running");
	if (!running.ok) {
		return starting;
	}

	try {
		const childSession = await createChildSession({ agent: running.agent, ctx, prompt });
		await childSession.prompt(prompt);
		const summary = lastAssistantText(childSession.messages);
		const finished = store.transitionAgent(running.agent.id, running.agent.revision, "completed", {
			result: summary ? { summary } : undefined,
		});
		return finished.ok ? finished.agent : running.agent;
	} catch (error) {
		const failed = store.transitionAgent(running.agent.id, running.agent.revision, "failed", {
			error: { message: error instanceof Error ? error.message : String(error) },
		});
		return failed.ok ? failed.agent : running.agent;
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
		const finished = store.transitionAgent(running.agent.id, running.agent.revision, dispatchResult.lifecycle, {
			error: dispatchResult.error,
			result: dispatchResult.result,
		});
		return finished.ok ? finished.agent : running.agent;
	} catch (error) {
		const failed = store.transitionAgent(running.agent.id, running.agent.revision, "failed", {
			error: { message: error instanceof Error ? error.message : String(error) },
		});
		return failed.ok ? failed.agent : running.agent;
	}
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

function waitAgent(store: MultiAgentStore, params: WaitAgentParams): AgentToolResult<AgentToolDetails> {
	const agent = store.getAgent(params.agentId);
	if (!agent) {
		return errorResult(`Agent not found: ${params.agentId}`, { agent: emptyAgent(params.agentId), terminal: true });
	}

	const terminal = !isActiveLifecycle(agent.lifecycle);
	return result(`${agent.displayName} is ${agent.lifecycle}.`, { agent, terminal });
}

function cancelAgent(store: MultiAgentStore, params: CancelAgentParams): AgentToolResult<AgentToolDetails> {
	const cancelled = store.transitionAgent(params.agentId, params.expectedRevision, "aborted");
	if (!cancelled.ok) {
		return errorResult(`Could not cancel ${params.agentId}: ${cancelled.error}`, {
			agent: "current" in cancelled ? cancelled.current : emptyAgent(params.agentId),
			reason: params.reason,
		});
	}

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

export default function multiAgentExtension(pi: ExtensionAPI, options: MultiAgentExtensionOptions = {}) {
	const store = options.store ?? new MultiAgentStore();
	const createChildSession = options.createChildSession;
	const dispatcher = options.dispatcher;

	pi.registerTool(
		defineTool({
			name: "spawn_agent",
			label: "Spawn Agent",
			description: "Create a child agent record and optionally dispatch it through the multi-agent runtime.",
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
			parameters: listAgentsSchema,
			execute: async (_toolCallId, params) => listAgents(store, params),
		}),
	);

	pi.registerTool(
		defineTool({
			name: "wait_agent",
			label: "Wait Agent",
			description: "Read the current agent state and whether it is terminal.",
			parameters: waitAgentSchema,
			execute: async (_toolCallId, params) => waitAgent(store, params),
		}),
	);

	pi.registerTool(
		defineTool({
			name: "cancel_agent",
			label: "Cancel Agent",
			description: "Cancel an agent through the multi-agent store with revision checking.",
			parameters: cancelAgentSchema,
			execute: async (_toolCallId, params) => cancelAgent(store, params),
		}),
	);

	pi.registerTool(
		defineTool({
			name: "contact_supervisor",
			label: "Contact Supervisor",
			description: "Send a child-agent mailbox request to its direct supervisor.",
			parameters: contactSupervisorSchema,
			execute: async (_toolCallId, params) => contactSupervisor(store, params),
		}),
	);

	pi.registerTool(
		defineTool({
			name: "steer_agent",
			label: "Steer Agent",
			description: "Queue a steering message through the multi-agent mailbox.",
			parameters: steerAgentSchema,
			execute: async (_toolCallId, params) => steerAgent(store, params),
		}),
	);
}
