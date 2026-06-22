import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	registerAgentViewerTools,
	type MultiAgentExtensionOptions,
} from "../../agents-core/src/runtime.ts";

export default function agentViewerExtension(pi: ExtensionAPI, options: MultiAgentExtensionOptions = {}) {
	registerAgentViewerTools(pi, options);
}
