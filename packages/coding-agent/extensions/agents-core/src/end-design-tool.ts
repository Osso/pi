import { Type } from "typebox";
import type { ToolDefinition } from "../../../src/core/extensions/types.ts";
import { findExactModelReferenceMatch } from "../../../src/core/model-resolver.ts";

const endDesignSchema = Type.Object(
	{
		handoff: Type.String({
			minLength: 1,
			pattern: "\\S",
			description: "The design to implement: decided rules, edge cases, design note path, and acceptance-test commit.",
		}),
	},
	{ additionalProperties: false },
);

/**
 * Child-only tool for agents whose profile sets `implementAs`: ends the design phase by switching this agent's own
 * session to the named profile's model and effort, from its next model request.
 */
export function createEndDesignToolDefinition(implementAs: string): ToolDefinition<typeof endDesignSchema> {
	return {
		name: "end_design",
		label: "End Design",
		description: `End the design phase and continue implementing in this session on the "${implementAs}" profile's model. Call it once, after the design is decided and its acceptance tests are committed.`,
		promptGuidelines: [
			"Decide the design and commit failing acceptance tests first, then call end_design with the handoff and implement it.",
		],
		approvalRequired: false,
		parameters: endDesignSchema,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const profile = ctx.settingsManager?.getAgentProfile(implementAs);
			if (!profile?.model) throw new Error(`Agent profile "${implementAs}" has no model`);
			const model = findExactModelReferenceMatch(profile.model, ctx.modelRegistry.getAll());
			if (!model) throw new Error(`Model not found: ${profile.model}`);
			if (ctx.model?.provider === model.provider && ctx.model.id === model.id) {
				throw new Error(`Design already ended: this agent already runs ${model.provider}/${model.id}`);
			}
			if (!(await ctx.setModel?.(model))) throw new Error(`No API key for ${model.provider}/${model.id}`);
			if (profile.thinkingLevel) ctx.setThinkingLevel?.(profile.thinkingLevel);
			const effort = ctx.getThinkingLevel?.() ?? profile.thinkingLevel ?? "default";
			return {
				content: [
					{
						type: "text",
						text: `Design ended. From your next request you run ${model.provider}/${model.id} at effort ${effort}. Implement this handoff now:\n${params.handoff}`,
					},
				],
				details: { provider: model.provider, modelId: model.id, thinkingLevel: effort },
			};
		},
	};
}
