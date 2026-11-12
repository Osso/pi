import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AgentViewerExtensionOptions, registerAgentViewerTools } from "./runtime.ts";

export default function agentViewerExtension(pi: ExtensionAPI, options: AgentViewerExtensionOptions = {}) {
	registerAgentViewerTools(pi, options);
}
