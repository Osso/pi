export {
	type AskQuestionsToolDetails,
	type AskQuestionsToolInput,
	createAskQuestionsToolDefinition,
} from "./ask-questions.ts";
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	type BroadcastToolDetails,
	type BroadcastToolInput,
	createBroadcastToolDefinition,
} from "./broadcast.ts";
export {
	type ChannelPostToolDetails,
	type ChannelPostToolInput,
	createChannelPostToolDefinition,
} from "./channel-post.ts";
export {
	type CodeIndexCommandResult,
	type CodeIndexOperations,
	type CodeIndexToolDetails,
	type CodeIndexToolOptions,
	createOutlineTool,
	createOutlineToolDefinition,
	createReferencesTool,
	createReferencesToolDefinition,
	createSymbolTool,
	createSymbolToolDefinition,
	type OutlineToolInput,
	type ReferencesToolInput,
	type SymbolToolInput,
} from "./code-index.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createListSessionsToolDefinition,
	type ListSessionsToolDetails,
	type ListSessionsToolInput,
} from "./list-sessions.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	createResumeSessionToolDefinition,
	type ResumeSessionToolDetails,
	type ResumeSessionToolInput,
} from "./resume-session.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import { createAskQuestionsToolDefinition } from "./ask-questions.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createBroadcastToolDefinition } from "./broadcast.ts";
import { createChannelPostToolDefinition } from "./channel-post.ts";
import {
	type CodeIndexToolOptions,
	createOutlineTool,
	createOutlineToolDefinition,
	createReferencesTool,
	createReferencesToolDefinition,
	createSymbolTool,
	createSymbolToolDefinition,
} from "./code-index.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createListSessionsToolDefinition } from "./list-sessions.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createResumeSessionToolDefinition } from "./resume-session.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName =
	| "read"
	| "bash"
	| "edit"
	| "write"
	| "grep"
	| "find"
	| "ls"
	| "outline"
	| "symbol"
	| "references"
	| "resume_session"
	| "list_sessions"
	| "broadcast"
	| "channel_post"
	| "ask_questions";
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"outline",
	"symbol",
	"references",
	"resume_session",
	"list_sessions",
	"broadcast",
	"channel_post",
	"ask_questions",
]);
export const DEFAULT_ACTIVE_TOOL_NAMES: ToolName[] = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"outline",
	"symbol",
	"references",
	"resume_session",
	"list_sessions",
	"broadcast",
	"channel_post",
	"ask_questions",
];

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
	codeIndex?: CodeIndexToolOptions;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		case "outline":
			return createOutlineToolDefinition(cwd, options?.codeIndex);
		case "symbol":
			return createSymbolToolDefinition(cwd, options?.codeIndex);
		case "references":
			return createReferencesToolDefinition(cwd, options?.codeIndex);
		case "resume_session":
			return createResumeSessionToolDefinition();
		case "list_sessions":
			return createListSessionsToolDefinition();
		case "broadcast":
			return createBroadcastToolDefinition();
		case "channel_post":
			return createChannelPostToolDefinition();
		case "ask_questions":
			return createAskQuestionsToolDefinition();
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		case "outline":
			return createOutlineTool(cwd, options?.codeIndex);
		case "symbol":
			return createSymbolTool(cwd, options?.codeIndex);
		case "references":
			return createReferencesTool(cwd, options?.codeIndex);
		case "resume_session":
			return wrapToolDefinition(createResumeSessionToolDefinition());
		case "list_sessions":
			return wrapToolDefinition(createListSessionsToolDefinition());
		case "broadcast":
			return wrapToolDefinition(createBroadcastToolDefinition());
		case "channel_post":
			return wrapToolDefinition(createChannelPostToolDefinition());
		case "ask_questions":
			return wrapToolDefinition(createAskQuestionsToolDefinition());
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
		createOutlineToolDefinition(cwd, options?.codeIndex),
		createSymbolToolDefinition(cwd, options?.codeIndex),
		createReferencesToolDefinition(cwd, options?.codeIndex),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
		outline: createOutlineToolDefinition(cwd, options?.codeIndex),
		symbol: createSymbolToolDefinition(cwd, options?.codeIndex),
		references: createReferencesToolDefinition(cwd, options?.codeIndex),
		resume_session: createResumeSessionToolDefinition(),
		list_sessions: createListSessionsToolDefinition(),
		broadcast: createBroadcastToolDefinition(),
		channel_post: createChannelPostToolDefinition(),
		ask_questions: createAskQuestionsToolDefinition(),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createGrepTool(cwd, options?.grep),
		createFindTool(cwd, options?.find),
		createLsTool(cwd, options?.ls),
		createOutlineTool(cwd, options?.codeIndex),
		createSymbolTool(cwd, options?.codeIndex),
		createReferencesTool(cwd, options?.codeIndex),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
		outline: createOutlineTool(cwd, options?.codeIndex),
		symbol: createSymbolTool(cwd, options?.codeIndex),
		references: createReferencesTool(cwd, options?.codeIndex),
		resume_session: wrapToolDefinition(createResumeSessionToolDefinition()),
		list_sessions: wrapToolDefinition(createListSessionsToolDefinition()),
		broadcast: wrapToolDefinition(createBroadcastToolDefinition()),
		channel_post: wrapToolDefinition(createChannelPostToolDefinition()),
		ask_questions: wrapToolDefinition(createAskQuestionsToolDefinition()),
	};
}
