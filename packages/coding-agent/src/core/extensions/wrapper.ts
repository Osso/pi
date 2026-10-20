/** Tool adapters at the extension boundary. Core-owned tool writes stay unchanged. */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import type { ExtensionRunner } from "./runner.ts";
import type { RegisteredTool } from "./types.ts";

/** Give extension tools context and detach their results before core retains them. */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	const definition = registeredTool.definition;
	const context = () => runner.createContext();
	if (registeredTool.sourceInfo.source === "builtin") return wrapToolDefinition(definition, context);
	return wrapToolDefinition(
		{
			...definition,
			...(definition.prepareExecution
				? {
						prepareExecution: async (id, signal, ctx) =>
							structuredClone(await definition.prepareExecution?.(id, signal, ctx)),
					}
				: {}),
			async execute(id, params, signal, onUpdate, ctx) {
				const isolatedUpdate = onUpdate
					? (partial: Parameters<typeof onUpdate>[0]) => onUpdate(structuredClone(partial))
					: undefined;
				const result = await definition.execute(id, params, signal, isolatedUpdate, ctx);
				return structuredClone(result);
			},
		},
		context,
	);
}

/** Wrap registered tools individually to keep built-in results on the trusted path. */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map((tool) => wrapRegisteredTool(tool, runner));
}
