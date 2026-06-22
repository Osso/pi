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
	type AgentSnapshot,
	isActiveLifecycle,
	MultiAgentStore,
	type SteeringCheckpoint,
} from "../core/multi-agent-store.ts";

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

type SpawnAgentParams = Static<typeof spawnAgentSchema>;
type ListAgentsParams = Static<typeof listAgentsSchema>;
type WaitAgentParams = Static<typeof waitAgentSchema>;
type CancelAgentParams = Static<typeof cancelAgentSchema>;
type SteerAgentParams = Static<typeof steerAgentSchema>;

export interface MultiAgentExtensionOptions {
	store?: MultiAgentStore;
}

interface AgentToolDetails {
	agent: AgentSnapshot;
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

function spawnAgent(
	store: MultiAgentStore,
	params: SpawnAgentParams,
	ctx: ExtensionContext,
): AgentToolResult<AgentToolDetails> {
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

	return result(`Spawned ${spawned.agent.displayName} (${spawned.agent.id})`, {
		agent: spawned.agent,
		prompt: params.prompt,
	});
}

function listAgents(store: MultiAgentStore, params: ListAgentsParams): AgentToolResult<AgentListToolDetails> {
	const agents = params.activeOnly ? store.listActiveAgents() : store.listAgents();

	return result(`Found ${agents.length} agent${agents.length === 1 ? "" : "s"}.`, {
		activeCount: store.getActiveAgentCount(),
		agents,
	});
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

export default function multiAgentExtension(pi: ExtensionAPI, options: MultiAgentExtensionOptions = {}) {
	const store = options.store ?? new MultiAgentStore();

	pi.registerTool(
		defineTool({
			name: "spawn_agent",
			label: "Spawn Agent",
			description: "Create a child agent record in the multi-agent store without starting a model session.",
			parameters: spawnAgentSchema,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => spawnAgent(store, params, ctx),
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
			name: "steer_agent",
			label: "Steer Agent",
			description: "Queue a steering message through the multi-agent mailbox.",
			parameters: steerAgentSchema,
			execute: async (_toolCallId, params) => steerAgent(store, params),
		}),
	);
}
