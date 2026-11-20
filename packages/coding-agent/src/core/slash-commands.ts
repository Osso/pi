import { APP_NAME } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "cd", description: "Move the current session to another working directory" },
	{ name: "name", description: "Set session display name" },
	{ name: "unname", description: "Remove session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "tools", description: "Show available tools" },
	{ name: "extensions", description: "Show loaded extensions" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	{ name: "login", description: "Configure provider authentication" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "continue", description: "Continue from the current transcript without adding a user message" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "agents", description: "Open agent switcher" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
];

const BUILTIN_SLASH_COMMAND_NAMES = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));

/** Built-in dispatch matches "/name args"; accept any whitespace (e.g. Shift+Enter) after a built-in name. */
export function normalizeBuiltinSlashCommandSeparator(text: string): string {
	const match = /^\/(\S+)\s/.exec(text);
	if (!match?.[1] || !BUILTIN_SLASH_COMMAND_NAMES.has(match[1])) return text;
	return `/${match[1]} ${text.slice(match[0].length)}`;
}
