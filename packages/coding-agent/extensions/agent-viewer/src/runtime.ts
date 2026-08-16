import { type Static, Type } from "typebox";
import {
	formatAgentLifecycleTrace,
	readAgentLifecycleTrace,
	type AgentLifecycleTrace,
} from "../../../src/core/agent-lifecycle-trace.ts";
import {
	type AgentToolResult,
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "../../../src/core/extensions/types.ts";
import { type AgentSnapshot, isActiveLifecycle, MultiAgentStore } from "../../../src/core/multi-agent-store.ts";
import { listSessionMetadata, readMultiAgentState } from "../../../src/core/session-control-db.ts";

const agentViewerSchema = Type.Object({
	agentId: Type.String(),
	sessionId: Type.Optional(Type.String()),
	storeSessionId: Type.Optional(Type.String()),
	trace: Type.Optional(Type.Boolean()),
});

type AgentViewerParams = Static<typeof agentViewerSchema>;

export interface AgentViewerExtensionOptions {
	store?: MultiAgentStore;
}

interface AgentViewerToolDetails extends Record<string, unknown> {
	agent?: AgentSnapshot;
	agentId?: string;
	children?: string[];
	commands?: AgentViewerCommand[];
	error?:
		| "missing_control_db"
		| "not_found"
		| "session_mismatch"
		| "session_not_found"
		| "trace_requires_store_session";
	parentId?: string;
	sessionId?: string;
	status?: AgentViewerStatus;
	trace?: AgentLifecycleTrace;
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
	tool: "close_agent" | "steer_agent";
}

type PersistedAgentViewerLoad =
	| { agents: AgentSnapshot[]; controlDbPath: string; error?: undefined; sessionPath: string }
	| { agents?: undefined; controlDbPath?: undefined; error: AgentToolResult<AgentViewerToolDetails>; sessionPath?: undefined };

export function registerAgentViewerTools(pi: ExtensionAPI, options: AgentViewerExtensionOptions = {}): void {
	const store = options.store ?? new MultiAgentStore();
	pi.registerTool(
		defineTool({
			name: "agent_viewer",
			label: "Agent Viewer",
			description:
				"Inspect one agent by ID, with status, transcript, child IDs, command descriptors, and optional historical lifecycle and descendant trace.",
			approvalRequired: false,
			parameters: agentViewerSchema,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => agentViewer(store, params, ctx),
		}),
	);
}

function agentViewer(
	store: MultiAgentStore,
	params: AgentViewerParams,
	ctx?: ExtensionContext,
): AgentToolResult<AgentViewerToolDetails> {
	if (params.trace && !params.storeSessionId) {
		return errorResult("Historical lifecycle trace requires storeSessionId.", {
			agentId: params.agentId,
			error: "trace_requires_store_session" as const,
		});
	}
	if (params.storeSessionId) return agentViewerFromPersistedSession(params, ctx);
	const agent = store.getAgent(params.agentId);
	if (!agent) {
		return errorResult(`Agent not found: ${params.agentId}.`, {
			agentId: params.agentId,
			error: "not_found" as const,
		});
	}
	const sessionError = validateTranscriptSession(agent, params);
	return sessionError ?? agentViewerResult(agent, store.listAgents());
}

function agentViewerFromPersistedSession(
	params: AgentViewerParams,
	ctx?: ExtensionContext,
): AgentToolResult<AgentViewerToolDetails> {
	const loaded = loadPersistedAgentsForViewer(params, ctx);
	if (loaded.error) return loaded.error;
	const agent = loaded.agents.find((candidate) => candidate.id === params.agentId);
	if (!agent) return persistedAgentNotFound(params);
	const sessionError = validateTranscriptSession(agent, params);
	if (sessionError) return sessionError;
	const trace = params.trace
		? readAgentLifecycleTrace({
				agent,
				agents: loaded.agents,
				controlDbPath: loaded.controlDbPath,
				sessionPath: loaded.sessionPath,
			})
		: undefined;
	return agentViewerResult(agent, loaded.agents, trace);
}

function loadPersistedAgentsForViewer(
	params: AgentViewerParams,
	ctx?: ExtensionContext,
): PersistedAgentViewerLoad {
	const controlDbPath = ctx?.controlDbPath;
	if (!controlDbPath) return missingControlDb(params);
	const session = listSessionMetadata(controlDbPath).find((metadata) => metadata.id === params.storeSessionId);
	if (!session) return persistedSessionNotFound(params);
	const state = readMultiAgentState(controlDbPath, session.sessionPath);
	return {
		agents: state?.agents.filter(isPersistedAgentSnapshot) ?? [],
		controlDbPath,
		sessionPath: session.sessionPath,
	};
}

function agentViewerResult(
	agent: AgentSnapshot,
	agents: AgentSnapshot[],
	trace?: AgentLifecycleTrace,
): AgentToolResult<AgentViewerToolDetails> {
	const children = agents.filter((candidate) => candidate.parentId === agent.id).map((child) => child.id);
	return result(formatAgentViewerContent(agent, trace), {
		agent,
		children,
		commands: listViewerCommands(agent),
		parentId: agent.parentId,
		status: viewStatus(agent),
		trace,
		transcript: viewTranscript(agent),
	});
}

function formatAgentViewerContent(agent: AgentSnapshot, trace?: AgentLifecycleTrace): string {
	const terminal = !isActiveLifecycle(agent.lifecycle);
	const lines = [
		`Viewing agent ${agent.id}: name=${JSON.stringify(agent.displayName)} type=${agent.agentType} status=${terminal ? "terminal" : "active"} lifecycle=${agent.lifecycle}`,
	];
	if (terminal && agent.result?.summary) lines.push(`Summary: ${agent.result.summary}`);
	if (terminal && agent.error?.message) {
		lines.push(`Error: ${agent.error.message}${agent.error.code ? ` (${agent.error.code})` : ""}`);
	}
	if (trace) lines.push(formatAgentLifecycleTrace(trace));
	return lines.join("\n");
}

function validateTranscriptSession(
	agent: AgentSnapshot,
	params: AgentViewerParams,
): AgentToolResult<AgentViewerToolDetails> | undefined {
	if (!params.sessionId || agent.transcript?.sessionId === params.sessionId) return undefined;
	return errorResult(`Agent ${params.agentId} is not attached to session ${params.sessionId}.`, {
		agentId: params.agentId,
		error: "session_mismatch" as const,
		sessionId: params.sessionId,
	});
}

function missingControlDb(params: AgentViewerParams): PersistedAgentViewerLoad {
	return {
		error: errorResult("Cannot view a persisted agent without a control DB.", {
			agentId: params.agentId,
			error: "missing_control_db" as const,
			storeSessionId: params.storeSessionId,
		}),
	};
}

function persistedSessionNotFound(params: AgentViewerParams): PersistedAgentViewerLoad {
	return {
		error: errorResult(`Session not found: ${params.storeSessionId}.`, {
			agentId: params.agentId,
			error: "session_not_found" as const,
			storeSessionId: params.storeSessionId,
		}),
	};
}

function persistedAgentNotFound(params: AgentViewerParams): AgentToolResult<AgentViewerToolDetails> {
	return errorResult(`Agent not found: ${params.agentId}.`, {
		agentId: params.agentId,
		error: "not_found" as const,
		storeSessionId: params.storeSessionId,
	});
}

function isPersistedAgentSnapshot(value: unknown): value is AgentSnapshot {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<AgentSnapshot>;
	return typeof candidate.id === "string" && typeof candidate.lifecycle === "string" && typeof candidate.revision === "number";
}

function viewStatus(agent: AgentSnapshot): AgentViewerStatus {
	return {
		agentId: agent.id,
		lifecycle: agent.lifecycle,
		revision: agent.revision,
		terminal: !isActiveLifecycle(agent.lifecycle),
	};
}

function viewTranscript(agent: AgentSnapshot): AgentViewerTranscript | undefined {
	if (!agent.transcript) return undefined;
	return {
		agentId: agent.id,
		path: agent.transcript.path,
		sessionId: agent.transcript.sessionId,
	};
}

function listViewerCommands(agent: AgentSnapshot): AgentViewerCommand[] {
	return [
		{ agentId: agent.id, command: "stop", tool: "close_agent" },
		{ agentId: agent.id, command: "steer", tool: "steer_agent" },
	];
}

function result<TDetails extends Record<string, unknown>>(text: string, details: TDetails): AgentToolResult<TDetails> {
	return { content: [{ text, type: "text" }], details };
}

function errorResult<TDetails extends Record<string, unknown>>(
	text: string,
	details: TDetails,
): AgentToolResult<TDetails> {
	return { content: [{ text, type: "text" }], details };
}
