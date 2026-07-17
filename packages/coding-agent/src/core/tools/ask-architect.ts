import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { postArchitectRequest } from "../session-control-db.ts";

const askArchitectSchema = Type.Object({
	message: Type.String({ description: "Question or diagnostic request for the resident Architect." }),
	project_path: Type.Optional(
		Type.String({
			description: "Absolute project directory, such as the active worktree. Defaults to the session cwd.",
		}),
	),
});

export type AskArchitectToolInput = Static<typeof askArchitectSchema>;

export interface AskArchitectToolDetails {
	requestId: number;
	senderSessionId: string;
}

export function createAskArchitectToolDefinition(): ToolDefinition<typeof askArchitectSchema, AskArchitectToolDetails> {
	return {
		name: "ask_architect",
		label: "ask_architect",
		description: "Queue a durable request for the resident Architect.",
		promptSnippet: "Ask the resident Architect",
		promptGuidelines: [
			"Use this tool for direct Architect requests; do not use channel_post for Architect requests.",
			"Set project_path to the project directory, such as the active worktree, when it differs from the session cwd.",
			"Requests remain queued across Architect restarts until processed.",
		],
		parameters: askArchitectSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx?.multiAgentAgentId || ctx?.multiAgentRequiresAgentId || ctx?.sessionManager.isSubagentSession?.()) {
				throw new Error("ask_architect is only available from main sessions");
			}
			const controlDbPath = requireControlDbPath(ctx);
			const senderSessionId = ctx?.sessionManager.getSessionId();
			if (!senderSessionId) {
				throw new Error("ask_architect requires a persisted session id");
			}
			const requestId = postArchitectRequest(controlDbPath, {
				senderSessionId,
				projectCwd: resolveProjectPath(params.project_path, ctx.cwd),
				body: params.message,
			});
			return {
				content: [{ type: "text", text: `Architect request queued: ${requestId}` }],
				details: { requestId, senderSessionId },
			};
		},
		renderCall(_args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(`${theme.fg("toolTitle", theme.bold("ask_architect"))}`);
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

function resolveProjectPath(projectPath: string | undefined, sessionCwd: string): string {
	if (projectPath === undefined) return sessionCwd;
	if (!projectPath.trim() || !isAbsolute(projectPath)) {
		throw new Error("ask_architect project_path must be a non-empty absolute path");
	}
	let canonicalPath: string;
	try {
		canonicalPath = realpathSync(projectPath);
	} catch (error) {
		throw new Error("ask_architect project_path must reference an existing directory", { cause: error });
	}
	if (!statSync(canonicalPath).isDirectory()) {
		throw new Error("ask_architect project_path must reference a directory");
	}
	return canonicalPath;
}

function requireControlDbPath(ctx: ExtensionContext | undefined): string {
	if (!ctx?.controlDbPath) {
		throw new Error("ask_architect requires a control database path");
	}
	return ctx.controlDbPath;
}
