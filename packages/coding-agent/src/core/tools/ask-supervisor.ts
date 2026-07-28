import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { requestSupervisorDecision } from "../../supervisor/client.ts";
import { DEFAULT_SUPERVISOR_KB_DIR, resolveSupervisorProjectForCwd } from "../../supervisor/project-resolver.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";

const SUPERVISOR_ADVISORY_TIMEOUT_MS = 3 * 60 * 1_000;
const askSupervisorSchema = Type.Object({
	question: Type.String({ description: "Bounded advisory question for the resident Supervisor.", maxLength: 4_000 }),
	context: Type.Optional(
		Type.String({ description: "Optional bounded evidence relevant to the question.", maxLength: 8_000 }),
	),
});

export type AskSupervisorToolInput = Static<typeof askSupervisorSchema>;

export interface AskSupervisorToolDetails {
	answer?: string;
	projectId: string;
	senderSessionId: string;
}

export function createAskSupervisorToolDefinition(): ToolDefinition<
	typeof askSupervisorSchema,
	AskSupervisorToolDetails
> {
	return {
		name: "ask_supervisor",
		label: "ask_supervisor",
		description: "Ask the resident Supervisor for bounded advisory guidance.",
		promptSnippet: "Ask the resident Supervisor",
		promptGuidelines: [
			"Use this tool for direct advisory questions to the Supervisor.",
			"Supervisor answers are advisory text and do not mutate goals, policies, sessions, processes, or agents.",
			"Requests are durable and wait up to three minutes for a response.",
		],
		parameters: askSupervisorSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			assertMainSession(ctx);
			const controlDbPath = requireControlDbPath(ctx);
			const senderSessionId = ctx?.sessionManager.getSessionId();
			if (!senderSessionId) throw new Error("ask_supervisor requires a persisted session id");
			const projectId = resolveSupervisorProjectForCwd(ctx.cwd, DEFAULT_SUPERVISOR_KB_DIR);
			const response = await requestSupervisorDecision({
				controlDbPath,
				kind: "supervisor_advisory",
				payload: {
					question: params.question,
					...(params.context === undefined ? {} : { context: params.context }),
				},
				projectId,
				senderSessionId,
				timeoutMs: SUPERVISOR_ADVISORY_TIMEOUT_MS,
			});
			if (response.kind !== "advisory")
				throw new Error(response.kind === "error" ? response.reason : "Invalid Supervisor advisory response");
			return {
				content: [{ type: "text", text: response.answer }],
				details: { answer: response.answer, projectId, senderSessionId },
			};
		},
		renderCall(_args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold("ask_supervisor")));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = result.content
				.filter((item) => item.type === "text")
				.map((item) => item.text ?? "")
				.join("\n");
			text.setText(output ? `\n${theme.fg(result.isError ? "error" : "toolOutput", output)}` : "");
			return text;
		},
	};
}

function assertMainSession(ctx: ExtensionContext | undefined): void {
	if (ctx?.multiAgentAgentId || ctx?.multiAgentRequiresAgentId || ctx?.sessionManager.isSubagentSession?.()) {
		throw new Error("ask_supervisor is only available from main sessions");
	}
}

function requireControlDbPath(ctx: ExtensionContext | undefined): string {
	if (!ctx?.controlDbPath) throw new Error("ask_supervisor requires a control database path");
	return ctx.controlDbPath;
}
