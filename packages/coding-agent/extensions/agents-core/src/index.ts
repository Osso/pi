import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentsCoreTools, type MultiAgentExtensionOptions } from "./runtime.ts";

export default function agentsCoreExtension(pi: ExtensionAPI, options: MultiAgentExtensionOptions = {}) {
	registerAgentsCoreTools(pi, options);
}

export {
	cancelReservedAgentRuntime,
	createMultiAgentRuntimeHandles,
	createProductionAttachedSessionFactory,
	createProductionChildAgentSessionFactory,
} from "./runtime.ts";
export { createHostrunMultiAgentRequestHandler } from "./runtime.ts";
export type {
	AttachedSessionDispatchInput,
	AttachedSessionFactory,
	ChildAgentDispatcher,
	CancelReservedAgentResult,
	ChildAgentSessionFactory,
	HostrunMultiAgentRequestHandler,
	MultiAgentExtensionOptions,
	MultiAgentRuntimeHandles,
} from "./runtime.ts";
