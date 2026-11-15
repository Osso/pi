import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../core/extensions/types.ts";
import type { Theme } from "../modes/interactive/theme/theme.ts";

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
		Type.Literal("answer"),
		Type.Literal("escalate"),
		Type.Literal("error"),
	]),
	reason: Type.Optional(Type.String({ description: "Why this decision applies." })),
	instructions: Type.Optional(
		Type.String({ description: "Generic active-goal reminder, or the smallest evidence-backed corrective action." }),
	),
	objective: Type.Optional(Type.String({ description: "Additive objective for goal set decisions." })),
	answer: Type.Optional(Type.String({ description: "Text answer for advisory decisions." })),
	answers: Type.Optional(
		Type.Record(
			Type.String(),
			Type.Object({
				answer: Type.String({ description: "The answer: an option label, comma-separated labels, or free text." }),
				reason: Type.String({ description: "Short reason naming the evidence for this answer." }),
			}),
			{ description: "Question answers keyed by exact question text, for kind answer." },
		),
	),
});

/** The decision as the Supervisor TUI shows it: the kind, then each text field and question answer that is set. */
function formatSupervisorResponse(
	params: Partial<Static<typeof supervisorResponseParameters>> | undefined,
	theme: Theme,
): string {
	const title = theme.fg("toolTitle", theme.bold(SUPERVISOR_RESPONSE_TOOL_NAME));
	const header = params?.kind ? `${title} ${theme.fg("accent", params.kind)}` : title;
	const texts = [params?.answer, params?.reason, params?.instructions, params?.objective]
		.map((text) => text?.trim())
		.filter((text): text is string => Boolean(text));
	const answers = Object.entries(params?.answers ?? {}).map(
		([question, { answer, reason }]) => `${question} → ${answer} (${reason})`,
	);
	return [header, ...[...texts, ...answers].map((line) => theme.fg("toolOutput", line))].join("\n");
}

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
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSupervisorResponse(args, theme));
			return text;
		},
		// The call already shows the decision; the result only acknowledges it.
		renderResult: () => new Text("", 0, 0),
	};
}
