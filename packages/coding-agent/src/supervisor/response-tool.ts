import { Type } from "typebox";
import type { ToolDefinition } from "../core/extensions/types.ts";

export const SUPERVISOR_RESPONSE_TOOL_NAME = "supervisor_response";

const supervisorResponseParameters = Type.Object({
	kind: Type.Union([
		Type.Literal("approve"),
		Type.Literal("reject"),
		Type.Literal("complete"),
		Type.Literal("continue"),
		Type.Literal("pause"),
		Type.Literal("wait"),
		Type.Literal("set"),
		Type.Literal("advisory"),
		Type.Literal("error"),
	]),
	reason: Type.Optional(Type.String({ description: "Why this decision applies." })),
	instructions: Type.Optional(Type.String({ description: "Concrete next step for continue decisions." })),
	objective: Type.Optional(Type.String({ description: "Additive objective for goal set decisions." })),
	answer: Type.Optional(Type.String({ description: "Text answer for advisory decisions." })),
});

export function createSupervisorResponseTool(): ToolDefinition<typeof supervisorResponseParameters, unknown> {
	return {
		name: SUPERVISOR_RESPONSE_TOOL_NAME,
		label: "Supervisor response",
		description: "Submit exactly one structured Supervisor decision and end the current request.",
		promptSnippet: "Submit the final structured Supervisor decision",
		promptGuidelines: [
			"Call supervisor_response exactly once as the final action for every request.",
			"Do not emit assistant text, JSON, markdown, or call end_turn before or after supervisor_response.",
		],
		parameters: supervisorResponseParameters,
		executionMode: "sequential",
		execute: async (_toolCallId, params) => {
			const text =
				params.kind === "advisory" && params.answer?.trim() ? params.answer : "Supervisor response recorded.";
			return {
				content: [{ type: "text", text }],
				details: params,
				terminate: true,
			};
		},
	};
}
