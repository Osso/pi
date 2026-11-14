import { STANDALONE_DISABLED_TOOL_NAMES } from "./tool-capabilities.ts";

export type MultiAgentRuntimeRole = "standalone" | "orchestrator" | "child" | "observer";

export interface MultiAgentExecutionCapability {
	readonly kind: "multi-agent-execution";
}

const issuedMultiAgentExecutionCapabilities = new WeakSet<MultiAgentExecutionCapability>();

export function createMultiAgentExecutionCapability(): MultiAgentExecutionCapability {
	const capability: MultiAgentExecutionCapability = Object.freeze({ kind: "multi-agent-execution" });
	issuedMultiAgentExecutionCapabilities.add(capability);
	return capability;
}

interface StandaloneWorkerOptions {
	noSupervisor?: boolean;
	sessionManager?: { isPersisted(): boolean };
	multiAgentStore?: unknown;
	multiAgentRuntimeRole?: MultiAgentRuntimeRole;
	multiAgentExecutionCapability?: MultiAgentExecutionCapability;
	multiAgentAgentId?: unknown;
	multiAgentParentSessionId?: unknown;
	multiAgentRequiresAgentId?: unknown;
}

export function assertStandaloneWorkerOptions(config: StandaloneWorkerOptions): void {
	if (!config.noSupervisor) return;
	if (config.sessionManager?.isPersisted()) throw new Error("Standalone worker requires an in-memory session");
	const hasOrchestration =
		config.multiAgentStore ||
		(config.multiAgentRuntimeRole && config.multiAgentRuntimeRole !== "standalone") ||
		config.multiAgentExecutionCapability ||
		config.multiAgentAgentId ||
		config.multiAgentParentSessionId ||
		config.multiAgentRequiresAgentId;
	if (hasOrchestration) throw new Error("Standalone worker cannot receive multi-agent orchestration");
}

export function validateMultiAgentRuntimeRole(config: {
	multiAgentRuntimeRole?: MultiAgentRuntimeRole;
	multiAgentExecutionCapability?: MultiAgentExecutionCapability;
}): void {
	const role = config.multiAgentRuntimeRole ?? "standalone";
	const capability = config.multiAgentExecutionCapability;
	const hasIssuedCapability = capability !== undefined && issuedMultiAgentExecutionCapabilities.has(capability);
	if (role === "orchestrator" && !hasIssuedCapability) {
		throw new Error("Multi-agent orchestrator requires an issued execution capability");
	}
	if (role !== "orchestrator" && capability !== undefined) {
		throw new Error(`Multi-agent ${role} runtime cannot receive execution capability`);
	}
}

export function isAllowedSessionTool(
	name: string,
	allowedToolNames: Set<string> | undefined,
	excludedToolNames: Set<string> | undefined,
	noSupervisor: boolean,
): boolean {
	const requiresSupervisor = STANDALONE_DISABLED_TOOL_NAMES.has(name);
	if (noSupervisor && requiresSupervisor) return false;
	if (name === "end_turn") return true;
	return (!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name);
}
