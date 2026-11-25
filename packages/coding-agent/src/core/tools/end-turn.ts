import { type Static, Type } from "typebox";
import { getMessagesAfterLatestUserPrompt, hasPublicAssistantText } from "../end-turn-public-text.ts";
import type { ToolDefinition } from "../extensions/types.ts";

const endTurnSchema = Type.Object({
	reason: Type.String({ description: "Required non-empty reason for ending the current turn." }),
});

export type EndTurnToolInput = Static<typeof endTurnSchema>;

export interface EndTurnToolDetails {
	reason: string;
}

export function createEndTurnToolDefinition(
	scope: "main" | "child" = "main",
): ToolDefinition<typeof endTurnSchema, EndTurnToolDetails> {
	return {
		name: "end_turn",
		label: "end_turn",
		description: "End the current model turn. Provide a concise reason explaining why the turn is finished.",
		promptSnippet: "End the current model turn with a required reason",
		promptGuidelines: [
			"Call end_turn only when the task is complete, progress requires user input, or the user explicitly asks you to stop. If work remains and progress is possible, continue working instead of calling end_turn. Assistant text alone does not finish the turn.",
			"Provide one concise, non-empty reason.",
			"Thinking is never shown to the user. When responding to the user, write the reply as assistant text before calling end_turn; never leave an answer only in thinking.",
		],
		parameters: endTurnSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			if (params.reason.trim() === "") {
				throw new Error("end_turn reason must be a non-empty string");
			}
			if (scope === "main" && ctx?.sessionManager) {
				const messages = getMessagesAfterLatestUserPrompt(ctx.sessionManager.getBranch());
				if (messages && !hasPublicAssistantText(messages)) {
					throw new Error(
						"Cannot end the main turn without a visible reply to the latest user prompt. Thinking is never shown; write the reply as assistant text, then call end_turn again.",
					);
				}
			}
			return {
				content: [{ type: "text", text: `Turn ended: ${params.reason}` }],
				details: { reason: params.reason },
				terminate: true,
			};
		},
	};
}
