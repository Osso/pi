import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentsCoreTools, type MultiAgentExtensionOptions } from "./runtime.ts";

export default function agentsCoreExtension(pi: ExtensionAPI, options: MultiAgentExtensionOptions = {}) {
	registerAgentsCoreTools(pi, options);
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
