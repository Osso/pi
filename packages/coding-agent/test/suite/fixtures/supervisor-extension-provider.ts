import { appendFileSync } from "node:fs";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";

// Mirrors claude-bridge: only the first module instance in a process registers its provider, a launch
// without the Pi session cwd fails, and a session prompt must have been captured by this module's own
// before_agent_start hook unless the call is a cacheRetention "none" one-off.
const ACTIVE_PROVIDER_KEY = Symbol.for("supervisor-extension-provider:active");
const capturedSystemPrompts = new Set<string>();

function respond(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		if (message.stopReason === "error") {
			stream.push({ type: "error", reason: "error", error: message });
			return;
		}
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
	});
	return stream;
}

export default function (pi: ExtensionAPI) {
	const reportPath = process.env.PI_SUPERVISOR_EXTENSION_REPORT;
	if (!reportPath) throw new Error("PI_SUPERVISOR_EXTENSION_REPORT is required");
	pi.on("before_agent_start", (event) => {
		capturedSystemPrompts.add(event.systemPrompt);
	});
	pi.registerTool({
		name: "bridge_probe_tool",
		label: "Bridge probe",
		description: "Must not reach the Supervisor tool surface",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "probe" }], details: {} }),
	});
	const registry = globalThis as Record<symbol, unknown>;
	if (registry[ACTIVE_PROVIDER_KEY]) return;
	registry[ACTIVE_PROVIDER_KEY] = true;
	pi.registerProvider("bridge-faux", {
		api: "bridge-faux-api",
		baseUrl: "bridge-faux",
		apiKey: "not-used",
		models: [
			{
				id: "haiku",
				name: "Bridge Haiku",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8_000,
			},
		],
		streamSimple: (model, context, options) => {
			if (!options?.cwd) throw new Error("Bridge launch requires the current Pi session cwd");
			const resident = context.tools?.some((tool) => tool.name === "supervisor_response") ?? false;
			const oneOff = options.cacheRetention === "none";
			const captured = oneOff || capturedSystemPrompts.has(context.systemPrompt ?? "");
			appendFileSync(
				reportPath,
				`${JSON.stringify({
					pid: process.pid,
					provider: model.provider,
					modelId: model.id,
					cwd: options.cwd,
					resident,
					oneOff,
					captured,
					tools: (context.tools ?? []).map((tool) => tool.name).sort(),
					unrelatedPromptMarker: context.systemPrompt?.includes("UNRELATED-EXTENSION-MARKER") ?? false,
				})}\n`,
			);
			if (!captured) {
				return respond(
					fauxAssistantMessage([], {
						stopReason: "error",
						errorMessage: "prompt-capture: no capture for this prompt",
					}),
				);
			}
			return respond(
				resident
					? fauxAssistantMessage(
							fauxToolCall("supervisor_response", {
								kind: "set",
								objective: "Reviewed by the extension provider",
								reason: "Reviewed",
							}),
							{ stopReason: "toolUse" },
						)
					: fauxAssistantMessage("ACCEPT"),
			);
		},
	});
}
