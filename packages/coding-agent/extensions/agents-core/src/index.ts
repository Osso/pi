import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRenameAgentTool } from "./agent-name-tool.ts";
import { registerAgentsCoreTools, type MultiAgentExtensionOptions } from "./runtime.ts";

export default function agentsCoreExtension(pi: ExtensionAPI, options: MultiAgentExtensionOptions = {}) {
	registerAgentsCoreTools(pi, options);
	registerRenameAgentTool(pi);
}

export {
	cancelOwnedAgentRuntime,
	consumeNotifications,
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
export { createMultiAgentPiRequestHandler } from "./runtime.ts";
export type {
	AgentSteeringRequest,
	AgentSteeringRequestResult,
	AgentSteeringRuntimeBinding,
	AttachedSessionDispatchInput,
	AttachedSessionFactory,
	CancelReservedAgentResult,
	ChildAgentSessionFactory,
	MultiAgentPiRequestHandler,
	MultiAgentExtensionOptions,
	MultiAgentRuntimeHandles,
	WaitNotificationsWake,
} from "./runtime.ts";
