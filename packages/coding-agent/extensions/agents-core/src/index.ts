import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRenameAgentTool } from "./agent-name-tool.ts";
import { type MultiAgentExtensionOptions, registerAgentsCoreTools } from "./runtime.ts";

export default function agentsCoreExtension(pi: ExtensionAPI, options: MultiAgentExtensionOptions = {}) {
	registerAgentsCoreTools(pi, options);
	registerRenameAgentTool(pi);
}

export type {
	AgentSteeringRequest,
	AgentSteeringRequestResult,
	AgentSteeringRuntimeBinding,
	AttachedSessionDispatchInput,
	AttachedSessionFactory,
	CancelReservedAgentResult,
	ChildAgentSessionFactory,
	MultiAgentExtensionOptions,
	MultiAgentPiRequestHandler,
	MultiAgentRuntimeHandles,
	WaitNotificationsWake,
} from "./runtime.ts";
export {
	cancelOwnedAgentRuntime,
	consumeNotifications,
	createMultiAgentPiRequestHandler,
	createMultiAgentRuntimeHandles,
	createProductionAttachedSessionFactory,
	createProductionChildAgentSessionFactory,
	requestAgentSteering,
	requestInteractiveAgentSteering,
	resolveSelectedSessionMutationTarget,
	waitNotifications,
	wakeWaitAgentsAfterCoordination,
	wakeWaitAgentsAfterSteering,
} from "./runtime.ts";
