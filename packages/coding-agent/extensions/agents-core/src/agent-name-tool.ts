import { type Static, Type } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "../../../src/core/extensions/types.ts";

const renameAgentSchema = Type.Object(
	{
		agentId: Type.String({ description: "ID of the existing sub-agent to rename." }),
		displayName: Type.String({ description: "New nonblank, single-line display name." }),
	},
	{ additionalProperties: false },
);

type RenameAgentParams = Static<typeof renameAgentSchema>;

export function renameAgent(params: RenameAgentParams, ctx: ExtensionContext) {
	if (ctx.multiAgentAgentId !== undefined || ctx.multiAgentRequiresAgentId === true) {
		throw new Error("rename_agent is controlled by the main thread");
	}
	if (!ctx.multiAgentStore) throw new Error("rename_agent requires a multi-agent store");
	const result = ctx.multiAgentStore.renameAgent(params.agentId, params.displayName);
	if (!result.ok) throw new Error(`Agent not found: ${params.agentId}`);
	return {
		content: [
			{ type: "text" as const, text: `Renamed ${result.agent.id} to ${JSON.stringify(result.agent.displayName)}.` },
		],
		details: { agentId: result.agent.id, displayName: result.agent.displayName },
	};
}

export function registerRenameAgentTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "rename_agent",
			label: "Rename Agent",
			description: "Rename an existing sub-agent's display name without changing its identity, lifecycle, or work.",
			approvalRequired: false,
			parameters: renameAgentSchema,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => renameAgent(params, ctx),
		}),
	);
}
