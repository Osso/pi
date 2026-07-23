import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { resolvePath } from "../../utils/paths.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { SessionManager } from "../session-manager.ts";
import { findSessionFileById } from "./resume-session.ts";

const changeWorkingDirectorySchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory path to adopt as the current session cwd." })),
	id: Type.Optional(Type.String({ description: "Pi session ID whose recorded cwd should be adopted." })),
});

export type ChangeWorkingDirectoryToolInput = Static<typeof changeWorkingDirectorySchema>;

export interface ChangeWorkingDirectoryToolDetails {
	cwd: string;
	previousCwd: string;
	source: "path" | "session";
	sessionId?: string;
}

type ChangeWorkingDirectoryTarget = { path: string; id?: undefined } | { id: string; path?: undefined };

function readNonEmptyTarget(record: Record<string, unknown>, key: "path" | "id"): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`change_working_directory ${key} must be a non-empty string`);
	}
	return value.trim();
}

function normalizeTarget(params: unknown): ChangeWorkingDirectoryTarget {
	if (!params || typeof params !== "object") {
		throw new Error("change_working_directory requires exactly one of path or id");
	}
	const record = params as Record<string, unknown>;
	const path = readNonEmptyTarget(record, "path");
	const id = readNonEmptyTarget(record, "id");
	if (path !== undefined && id === undefined) return { path };
	if (id !== undefined && path === undefined) return { id };
	throw new Error("change_working_directory requires exactly one of path or id");
}

async function loadTargetCwd(
	target: ChangeWorkingDirectoryTarget,
	ctx: ExtensionContext,
): Promise<{ cwd: string; source: "path" | "session"; sessionId?: string }> {
	if (target.path !== undefined) {
		return { cwd: resolvePath(target.path, ctx.cwd), source: "path" };
	}
	const sessionPath = await findSessionFileById(target.id, ctx);
	return {
		cwd: SessionManager.open(sessionPath).getCwd(),
		source: "session",
		sessionId: target.id,
	};
}

function formatCall(args: ChangeWorkingDirectoryToolInput | undefined, theme: Theme): string {
	const target = args?.path ? `path ${args.path}` : args?.id ? `session ${args.id}` : "target";
	return `${theme.fg("toolTitle", theme.bold("change_working_directory"))} ${theme.fg("accent", target)}`;
}

function formatResult(
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	theme: Theme,
): string {
	const output = result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text ?? "")
		.join("\n");
	return output ? `\n${theme.fg(result.isError ? "error" : "toolOutput", output)}` : "";
}

export function createChangeWorkingDirectoryToolDefinition(): ToolDefinition<
	typeof changeWorkingDirectorySchema,
	ChangeWorkingDirectoryToolDetails
> {
	return {
		name: "change_working_directory",
		label: "change_working_directory",
		description:
			"Change the current Pi session working directory without switching session identity. Pass a directory path, or a Pi session ID to adopt that session's recorded cwd. The referenced session is not modified.",
		promptSnippet: "Change the current session working directory by path or another session's recorded cwd",
		promptGuidelines: [
			"Use change_working_directory when subsequent relative tool operations should run from a different project directory.",
			"Pass exactly one of path or id. An id selects only that session's recorded cwd; it does not resume or modify the referenced session.",
		],
		parameters: changeWorkingDirectorySchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.relocate) {
				throw new Error("change_working_directory is not available in this session mode");
			}
			const target = normalizeTarget(params);
			const previousCwd = ctx.cwd;
			const resolved = await loadTargetCwd(target, ctx);
			await ctx.relocate(resolved.cwd);
			return {
				content: [{ type: "text", text: `Changed working directory to ${resolved.cwd}` }],
				details: { previousCwd, ...resolved },
				terminate: true,
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatCall(args, theme));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatResult(result, theme));
			return text;
		},
	};
}
