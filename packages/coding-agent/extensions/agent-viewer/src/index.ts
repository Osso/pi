import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentViewerTools, type AgentViewerExtensionOptions } from "./runtime.ts";

export default function agentViewerExtension(pi: ExtensionAPI, options: AgentViewerExtensionOptions = {}) {
	registerAgentViewerTools(pi, options);
}
