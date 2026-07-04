import { existsSync, statSync } from "node:fs";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { resolvePath } from "../../utils/paths.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import type { SessionInfo } from "../session-manager.ts";
import { SessionManager } from "../session-manager.ts";

const resumeSessionSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Path to a Pi .jsonl session file to resume." })),
	id: Type.Optional(Type.String({ description: "Exact or unique prefix of a Pi session id to resume." })),
	name: Type.Optional(Type.String({ description: "Unique named Pi session to resume." })),
	starter_prompt: Type.Optional(
		Type.String({ description: "Optional user prompt to send after the target session is resumed." }),
	),
});

export type ResumeSessionToolInput = Static<typeof resumeSessionSchema>;

export interface ResumeSessionToolDetails {
	cancelled: boolean;
	resumed: boolean;
	sessionPath: string;
}

interface ResumeSessionParams {
	id?: string;
	name?: string;
	path?: string;
	starterPrompt?: string;
}

function readNonEmptyString(
	record: Record<string, unknown>,
	key: "id" | "name" | "path" | "starter_prompt",
): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`resume_session ${key} must be a non-empty string`);
	}
	return value.trim();
}

function normalizeResumeSessionParams(params: unknown): ResumeSessionParams {
	if (!params || typeof params !== "object") {
		throw new Error("resume_session requires { path }, { id }, or { name }");
	}
	const record = params as Record<string, unknown>;
	const target = {
		id: readNonEmptyString(record, "id"),
		name: readNonEmptyString(record, "name"),
		path: readNonEmptyString(record, "path"),
	};
	const targetCount = Object.values(target).filter((value) => value !== undefined).length;
	if (targetCount !== 1) {
		throw new Error("resume_session requires exactly one of path, id, or name");
	}
	return {
		...target,
		starterPrompt: readNonEmptyString(record, "starter_prompt"),
	};
}

function assertResumeSessionPath(path: string): string {
	if (!existsSync(path) || !statSync(path).isFile()) {
		throw new Error(`Session file does not exist: ${path}`);
	}
	if (!path.endsWith(".jsonl")) {
		throw new Error(`Session file must be a .jsonl file: ${path}`);
	}
	return path;
}

function findUniqueSessionMatch(
	sessions: SessionInfo[],
	label: string,
	matches: (session: SessionInfo) => boolean,
): SessionInfo {
	const matched = sessions.filter(matches);
	if (matched.length === 0) {
		throw new Error(`No session found matching ${label}`);
	}
	if (matched.length > 1) {
		throw new Error(`Ambiguous session match for ${label}`);
	}
	const matchedSession = matched[0];
	if (!matchedSession) {
		throw new Error(`No session found matching ${label}`);
	}
	return matchedSession;
}

async function listResolvableSessions(ctx: ExtensionContext): Promise<SessionInfo[]> {
	const localSessions = await SessionManager.list(
		ctx.sessionManager.getCwd(),
		ctx.sessionManager.getSessionDir(),
		undefined,
		ctx.controlDbPath,
	);
	const defaultSessions = await SessionManager.listAll(undefined, undefined, ctx.controlDbPath);
	const sessionDirSessions = await SessionManager.listAll(
		ctx.sessionManager.getSessionDir(),
		undefined,
		ctx.controlDbPath,
	);
	return [
		...new Map(
			[...localSessions, ...defaultSessions, ...sessionDirSessions].map((session) => [session.path, session]),
		).values(),
	];
}

async function resolveResumeSessionFile(params: ResumeSessionParams, ctx: ExtensionContext): Promise<string> {
	if (params.path) {
		return assertResumeSessionPath(resolvePath(params.path, ctx.cwd));
	}

	const sessions = await listResolvableSessions(ctx);
	if (params.name) {
		return findUniqueSessionMatch(sessions, `name '${params.name}'`, (session) => session.name === params.name).path;
	}

	const id = params.id;
	if (!id) {
		throw new Error("resume_session requires { path }, { id }, or { name }");
	}
	const exactMatches = sessions.filter((session) => session.id === id);
	const exactMatch = exactMatches[0];
	if (exactMatches.length === 1 && exactMatch) return exactMatch.path;
	if (exactMatches.length > 1) throw new Error(`Ambiguous session match for id '${id}'`);
	return findUniqueSessionMatch(sessions, `id '${id}'`, (session) => session.id.startsWith(id)).path;
}

function formatResumeTarget(args: ResumeSessionToolInput | undefined): string {
	if (args?.path) return `path ${args.path}`;
	if (args?.id) return `id ${args.id}`;
	if (args?.name) return `name ${args.name}`;
	return "target";
}

function formatResumeSessionCall(args: ResumeSessionToolInput | undefined, theme: Theme): string {
	const target = formatResumeTarget(args);
	const starter = args?.starter_prompt ? theme.fg("warning", " + starter prompt") : "";
	return `${theme.fg("toolTitle", theme.bold("resume_session"))} ${theme.fg("accent", target)}${starter}`;
}

function formatResumeSessionResult(
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	theme: Theme,
): string | undefined {
	const output = result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text ?? "")
		.join("\n");
	if (!output) return undefined;
	return `\n${theme.fg(result.isError ? "error" : "toolOutput", output)}`;
}

export function createResumeSessionToolDefinition(): ToolDefinition<
	typeof resumeSessionSchema,
	ResumeSessionToolDetails
> {
	return {
		name: "resume_session",
		label: "resume_session",
		description:
			"Switch/resume the current main Pi session to another session file. This replaces the current supervisor context; only use when the user explicitly asks to resume or switch sessions. Optionally sends a starter prompt after the target session is active.",
		promptSnippet: "Switch/resume the current main Pi session, optionally with a starter prompt",
		promptGuidelines: [
			"Use resume_session only when the user explicitly asks to resume or switch the main session; it replaces the current supervisor context.",
			"Pass exactly one of path, id, or name. Use starter_prompt only for a user-provided prompt to send after the target session is active.",
		],
		parameters: resumeSessionSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx?.switchSession) {
				throw new Error("resume_session is not available in this session mode");
			}
			if (ctx.multiAgentAgentId || ctx.multiAgentRequiresAgentId) {
				throw new Error("resume_session is only available from the main supervisor session");
			}
			const resumeParams = normalizeResumeSessionParams(params);
			const sessionPath = await resolveResumeSessionFile(resumeParams, ctx);
			const starterPrompt = resumeParams.starterPrompt;
			const result = await ctx.switchSession(sessionPath, {
				withSession: starterPrompt
					? async (replacedCtx) => {
							await replacedCtx.sendUserMessage(starterPrompt);
						}
					: undefined,
			});
			const details = { cancelled: result.cancelled, resumed: !result.cancelled, sessionPath };
			const action = result.cancelled ? "Resume cancelled" : "Resumed session";
			const starter = starterPrompt && !result.cancelled ? " and sent starter prompt" : "";
			return {
				content: [{ type: "text", text: `${action}: ${sessionPath}${starter}` }],
				details,
				terminate: true,
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatResumeSessionCall(args, theme));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatResumeSessionResult(result, theme) ?? "");
			return text;
		},
	};
}
