import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import {
	type AgentToolResult,
	defineTool,
	type ExtensionAPI,
	type ViewedSessionMutationTarget,
} from "../../../src/core/extensions/types.ts";
import {
	type AgentSnapshot,
	formatInactiveAgentSelectionMessage,
	isActiveLifecycle,
	type MultiAgentStore,
} from "../../../src/core/multi-agent-store.ts";

const setAgentModelSchema = Type.Object(
	{
		agentId: Type.String(),
		provider: Type.Optional(Type.String({ description: "Model provider, e.g. openai-codex. Requires modelId." })),
		modelId: Type.Optional(Type.String({ description: "Model ID within the provider. Requires provider." })),
		thinkingLevel: Type.Optional(
			Type.Union(
				[
					Type.Literal("off"),
					Type.Literal("minimal"),
					Type.Literal("low"),
					Type.Literal("medium"),
					Type.Literal("high"),
					Type.Literal("xhigh"),
					Type.Literal("max"),
					Type.Literal("ultra"),
				],
				{ description: "Reasoning effort; clamped to what the model supports." },
			),
		),
	},
	{ additionalProperties: false },
);

type SetAgentModelParams = Static<typeof setAgentModelSchema>;

export interface SetAgentModelDetails {
	agentId: string;
	provider?: string;
	modelId?: string;
	thinkingLevel: ThinkingLevel;
}

/** Live child sessions keyed by agent ID; the runtime owns their lifetime. */
type LiveAgentSessions = ReadonlyMap<string, unknown>;

function hasMutationSurface(session: Partial<ViewedSessionMutationTarget>): session is ViewedSessionMutationTarget {
	return (
		"model" in session &&
		typeof session.setModel === "function" &&
		typeof session.setThinkingLevel === "function" &&
		typeof session.thinkingLevel === "string" &&
		session.modelRegistry !== undefined &&
		Array.isArray(session.scopedModels)
	);
}

/** Resolves the live, mutable session of one active child agent, without changing which agent is viewed. */
export function resolveLiveAgentMutationTarget(
	store: MultiAgentStore,
	sessions: LiveAgentSessions,
	agentId: string,
): ViewedSessionMutationTarget {
	const agent = store.getAgent(agentId);
	if (!agent) throw new Error(`Agent not found: ${agentId}`);
	if (agent.agentType === "background") {
		throw new Error(`Agent ${agentId} is detached and not a live child session`);
	}
	if (!isActiveLifecycle(agent.lifecycle)) throw new Error(formatInactiveAgentSelectionMessage(agent));
	const session = sessions.get(agentId) as Partial<ViewedSessionMutationTarget> | undefined;
	if (!session) throw new Error(`Agent ${agentId} is not a live child session`);
	if (!hasMutationSurface(session)) throw new Error(`Agent ${agentId} does not support live session mutation`);
	return session;
}

function readRequestedModel(params: SetAgentModelParams): { provider: string; modelId: string } | undefined {
	const provider = params.provider?.trim();
	const modelId = params.modelId?.trim();
	if (!provider && !modelId) return undefined;
	if (!provider || !modelId) {
		throw new Error("set_agent_model requires both provider and modelId to change the model");
	}
	return { provider, modelId };
}

function describeTarget(target: ViewedSessionMutationTarget): string {
	const model = target.model ? `${target.model.provider}/${target.model.id}` : "no model";
	return `${model}, effort ${target.thinkingLevel}`;
}

/**
 * Changes a running child's model and/or effort. The child's in-flight model request and tool calls continue
 * unchanged; the new settings apply from its next model request.
 */
export async function setAgentModel(
	store: MultiAgentStore,
	sessions: LiveAgentSessions,
	params: SetAgentModelParams,
): Promise<AgentToolResult<SetAgentModelDetails>> {
	const requested = readRequestedModel(params);
	if (!requested && !params.thinkingLevel) {
		throw new Error("set_agent_model requires provider and modelId, thinkingLevel, or both");
	}
	const target = resolveLiveAgentMutationTarget(store, sessions, params.agentId);
	if (requested) {
		const model = target.modelRegistry.find(requested.provider, requested.modelId);
		if (!model) throw new Error(`Model not found: ${requested.provider}/${requested.modelId}`);
		await target.setModel(model, "set", params.thinkingLevel);
	} else if (params.thinkingLevel) {
		target.setThinkingLevel(params.thinkingLevel);
	}
	const agent: AgentSnapshot | undefined = store.getAgent(params.agentId);
	const name = agent?.displayName ?? params.agentId;
	return {
		content: [
			{
				type: "text",
				text: `${name} (${params.agentId}) now uses ${describeTarget(target)}; applies from its next model request.`,
			},
		],
		details: {
			agentId: params.agentId,
			provider: target.model?.provider,
			modelId: target.model?.id,
			thinkingLevel: target.thinkingLevel,
		},
	};
}

export function registerSetAgentModelTool(
	pi: ExtensionAPI,
	store: MultiAgentStore,
	sessions: LiveAgentSessions,
): void {
	pi.registerTool(
		defineTool({
			name: "set_agent_model",
			label: "Set Agent Model",
			description:
				"Change a running child agent's model and/or reasoning effort by agent ID. The current model request is not interrupted; the change applies from the child's next model request.",
			promptGuidelines: [
				"Use set_agent_model only when the user asks to change a running sub-agent's model or effort.",
			],
			approvalRequired: false,
			parameters: setAgentModelSchema,
			execute: async (_toolCallId, params) => setAgentModel(store, sessions, params),
		}),
	);
}
