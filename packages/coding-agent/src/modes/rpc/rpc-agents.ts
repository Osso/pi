/**
 * Multi-agent commands and events for RPC clients: list agents, read a child
 * agent's transcript, steer it, and receive `agent_updated` on every change.
 */

import { existsSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSnapshot, MultiAgentStore } from "../../core/multi-agent-store.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { readSessionTranscriptPath } from "../../core/session-transcript.ts";
import type { RpcAgentCommand, RpcAgentUpdatedEvent, RpcResponse } from "./rpc-types.ts";

/** Multi-agent access for RPC mode; absent when the session runs without a Supervisor (`--no-supervisor`). */
export interface RpcAgentControls {
	store: MultiAgentStore;
	steer?: (agentId: string, message: string) => Promise<{ ok: boolean; error?: string }>;
}

const AGENT_COMMANDS = new Set<string>(["get_agents", "get_agent_messages", "steer_agent"]);

export function isRpcAgentCommand(command: { type: string }): command is RpcAgentCommand {
	return AGENT_COMMANDS.has(command.type);
}

/** Emits `agent_updated` for each store change; returns the unsubscribe function. */
export function forwardAgentUpdates(store: MultiAgentStore, output: (event: RpcAgentUpdatedEvent) => void): () => void {
	return store.subscribeAgentUpdates((_previous, agent) => output({ type: "agent_updated", agent }));
}

export async function handleRpcAgentCommand(
	command: RpcAgentCommand,
	controls: RpcAgentControls | undefined,
	sessionDir: string,
): Promise<RpcResponse> {
	const { id, type } = command;
	const failure = (message: string): RpcResponse => ({
		id,
		type: "response",
		command: type,
		success: false,
		error: message,
	});
	if (!controls) return failure("Agents are unavailable in this session (started with --no-supervisor)");
	switch (command.type) {
		case "get_agents":
			return {
				id,
				type: "response",
				command: "get_agents",
				success: true,
				data: { agents: controls.store.listAgents() },
			};
		case "get_agent_messages": {
			const agent = controls.store.getAgent(command.agentId);
			if (!agent) return failure(`Unknown agent: ${command.agentId}`);
			const messages = readAgentMessages(agent, sessionDir);
			return { id, type: "response", command: "get_agent_messages", success: true, data: { messages } };
		}
		case "steer_agent": {
			if (typeof command.message !== "string" || command.message.trim() === "")
				return failure("message must be a non-empty string");
			if (!controls.steer) return failure("Agent steering is unavailable");
			const result = await controls.steer(command.agentId, command.message);
			return result.ok
				? { id, type: "response", command: "steer_agent", success: true }
				: failure(result.error ?? "Steering failed");
		}
	}
}

/** The agent's transcript messages; empty until its transcript file exists. */
function readAgentMessages(agent: AgentSnapshot, sessionDir: string): AgentMessage[] {
	const path = agent.transcript?.path ? readSessionTranscriptPath(agent.transcript.path) : undefined;
	if (!path || !existsSync(path)) return [];
	return SessionManager.openReadOnly(path, sessionDir).buildSessionContext().messages;
}
