import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	registerAgentsCoreTools,
	registerSelectedSessionMutationResolver,
	type MultiAgentExtensionOptions,
} from "./runtime.ts";

export default function agentsCoreExtension(pi: ExtensionAPI, options: MultiAgentExtensionOptions = {}) {
	registerSelectedSessionMutationResolver(pi, options);
	registerAgentsCoreTools(pi, options);
}

export {
	cancelOwnedAgentRuntime,
	createMultiAgentRuntimeHandles,
	createProductionAttachedSessionFactory,
	createProductionChildAgentSessionFactory,
	requestAgentSteering,
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
	MultiAgentExtensionOptions,
	MultiAgentRuntimeHandles,
} from "./runtime.ts";
