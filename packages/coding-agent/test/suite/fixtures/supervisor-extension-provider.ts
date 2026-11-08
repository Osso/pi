import { appendFileSync } from "node:fs";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";

// Mirrors claude-bridge: only the first module instance in a process registers its provider,
// and a launch without the Pi session cwd fails.
const ACTIVE_PROVIDER_KEY = Symbol.for("supervisor-extension-provider:active");

function respond(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
	});
	return stream;
}

export default function (pi: ExtensionAPI) {
	const reportPath = process.env.PI_SUPERVISOR_EXTENSION_REPORT;
	if (!reportPath) throw new Error("PI_SUPERVISOR_EXTENSION_REPORT is required");
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
			appendFileSync(
				reportPath,
				`${JSON.stringify({ pid: process.pid, provider: model.provider, modelId: model.id, cwd: options.cwd, resident })}\n`,
			);
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
