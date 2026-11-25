export {
	type AnswerUserQuestionToolDetails,
	type AnswerUserQuestionToolInput,
	createAnswerUserQuestionToolDefinition,
} from "./answer-user-question.ts";
export {
	type AskArchitectToolDetails,
	type AskArchitectToolInput,
	createAskArchitectToolDefinition,
} from "./ask-architect.ts";
export {
	type AskQuestionsToolDetails,
	type AskQuestionsToolInput,
	createAskQuestionsToolDefinition,
} from "./ask-questions.ts";
export {
	type AskSupervisorToolDetails,
	type AskSupervisorToolInput,
	createAskSupervisorToolDefinition,
} from "./ask-supervisor.ts";
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
	type ChangeWorkingDirectoryToolDetails,
	type ChangeWorkingDirectoryToolInput,
	createChangeWorkingDirectoryToolDefinition,
} from "./change-working-directory.ts";
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
export {
	createEndTurnToolDefinition,
	type EndTurnToolDetails,
	type EndTurnToolInput,
} from "./end-turn.ts";
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
	createSearchCurrentSessionHistoryToolDefinition,
	type SearchCurrentSessionHistoryToolDetails,
	type SearchCurrentSessionHistoryToolInput,
	type SessionHistorySearchEntry,
} from "./search-current-session-history.ts";
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
import { isExecutableAvailable } from "../../utils/executable.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { createAnswerUserQuestionToolDefinition } from "./answer-user-question.ts";
import { createAskQuestionsToolDefinition } from "./ask-questions.ts";
import { createAskSupervisorToolDefinition } from "./ask-supervisor.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createChangeWorkingDirectoryToolDefinition } from "./change-working-directory.ts";
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
import { createEndTurnToolDefinition } from "./end-turn.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createListSessionsToolDefinition } from "./list-sessions.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createResumeSessionToolDefinition } from "./resume-session.ts";
import { createSearchCurrentSessionHistoryToolDefinition } from "./search-current-session-history.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool;
export type ToolDef = ToolDefinition;
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
	| "end_turn"
	| "change_working_directory"
	| "resume_session"
	| "search_current_session_history"
	| "list_sessions"
	| "channel_post"
	| "ask_questions"
	| "ask_supervisor"
	| "answer_user_question";
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
	"end_turn",
	"change_working_directory",
	"resume_session",
	"search_current_session_history",
	"list_sessions",
	"channel_post",
	"ask_questions",
	"ask_supervisor",
	"answer_user_question",
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
	"end_turn",
	"change_working_directory",
	"resume_session",
	"search_current_session_history",
	"list_sessions",
	"channel_post",
	"ask_questions",
	"ask_supervisor",
	"answer_user_question",
];

interface ReloadToolSession {
	getActiveToolNames(): string[];
	getAllTools(): Array<{ name: string }>;
}

export function getReloadActiveToolNames(
	session: ReloadToolSession,
	initialActiveToolNames?: readonly string[],
): string[] {
	const previousToolNames = new Set(session.getAllTools().map(({ name }) => name));
	const activeToolNames = new Set(session.getActiveToolNames());
	const configuredToolNames = initialActiveToolNames === undefined ? undefined : new Set(initialActiveToolNames);

	for (const name of DEFAULT_ACTIVE_TOOL_NAMES) {
		if (previousToolNames.has(name)) continue;
		if (configuredToolNames && !configuredToolNames.has(name)) continue;
		activeToolNames.add(name);
	}

	return [...activeToolNames];
}

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
		case "end_turn":
			return createEndTurnToolDefinition();
		case "change_working_directory":
			return createChangeWorkingDirectoryToolDefinition();
		case "resume_session":
			return createResumeSessionToolDefinition();
		case "search_current_session_history":
			return createSearchCurrentSessionHistoryToolDefinition();
		case "list_sessions":
			return createListSessionsToolDefinition();
		case "channel_post":
			return createChannelPostToolDefinition();
		case "ask_questions":
			return createAskQuestionsToolDefinition();
		case "answer_user_question":
			return createAnswerUserQuestionToolDefinition();
		case "ask_supervisor":
			return createAskSupervisorToolDefinition();
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
		case "end_turn":
			return wrapToolDefinition(createEndTurnToolDefinition());
		case "change_working_directory":
			return wrapToolDefinition(createChangeWorkingDirectoryToolDefinition());
		case "resume_session":
			return wrapToolDefinition(createResumeSessionToolDefinition());
		case "search_current_session_history":
			return wrapToolDefinition(createSearchCurrentSessionHistoryToolDefinition());
		case "list_sessions":
			return wrapToolDefinition(createListSessionsToolDefinition());
		case "channel_post":
			return wrapToolDefinition(createChannelPostToolDefinition());
		case "ask_questions":
			return wrapToolDefinition(createAskQuestionsToolDefinition());
		case "answer_user_question":
			return wrapToolDefinition(createAnswerUserQuestionToolDefinition());
		case "ask_supervisor":
			return wrapToolDefinition(createAskSupervisorToolDefinition());
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
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
		end_turn: createEndTurnToolDefinition(),
		change_working_directory: createChangeWorkingDirectoryToolDefinition(),
		resume_session: createResumeSessionToolDefinition(),
		search_current_session_history: createSearchCurrentSessionHistoryToolDefinition(),
		list_sessions: createListSessionsToolDefinition(),
		channel_post: createChannelPostToolDefinition(),
		ask_questions: createAskQuestionsToolDefinition(),
		answer_user_question: createAnswerUserQuestionToolDefinition(),
		ask_supervisor: createAskSupervisorToolDefinition(),
	};
}

export function createToolDefinitionsForAvailableExecutables(
	cwd: string,
	options?: ToolsOptions,
): Record<string, ToolDef> {
	const definitions: Record<string, ToolDef> = createAllToolDefinitions(cwd, options);
	if (options?.codeIndex?.operations || isExecutableAvailable("code-index")) return definitions;

	const codeIndexToolNames = new Set(["outline", "symbol", "references"]);
	return Object.fromEntries(Object.entries(definitions).filter(([name]) => !codeIndexToolNames.has(name)));
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
