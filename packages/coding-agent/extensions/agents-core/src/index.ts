import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentsCoreTools, type MultiAgentExtensionOptions } from "./runtime.ts";

export default function agentsCoreExtension(pi: ExtensionAPI, options: MultiAgentExtensionOptions = {}) {
	registerAgentsCoreTools(pi, options);
}

export {
	cancelOwnedAgentRuntime,
	createMultiAgentRuntimeHandles,
	createProductionAttachedSessionFactory,
	createProductionChildAgentSessionFactory,
	requestAgentSteering,
	resolveSelectedLiveChildSessionMutationTarget,
	resolveSelectedSessionMutationTarget,
} from "./runtime.ts";
export { createHostrunMultiAgentRequestHandler } from "./runtime.ts";
export type {
	AgentSteeringRequest,
	AgentSteeringRequestResult,
	AgentSteeringRuntimeBinding,
	AttachedSessionDispatchInput,
	AttachedSessionFactory,
	CancelReservedAgentResult,
	ChildAgentSessionFactory,
	HostrunMultiAgentRequestHandler,
	LiveChildSessionMutationTarget,
	MultiAgentExtensionOptions,
	MultiAgentRuntimeHandles,
} from "./runtime.ts";
