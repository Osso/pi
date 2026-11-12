import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type MultiAgentExtensionOptions, registerAgentsMailboxTools } from "../../agents-core/src/runtime.ts";

export default function agentsMailboxExtension(pi: ExtensionAPI, options: MultiAgentExtensionOptions = {}) {
	registerAgentsMailboxTools(pi, options);
}
