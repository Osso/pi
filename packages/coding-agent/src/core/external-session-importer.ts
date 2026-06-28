import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent, UserMessage } from "@earendil-works/pi-ai";
import { resolvePath } from "../utils/paths.ts";
import { CURRENT_SESSION_VERSION, type FileEntry, getDefaultSessionDir } from "./session-manager.ts";

const EXTERNAL_SESSION_PROVIDERS = ["codex", "claude"] as const;
type ExternalSessionProvider = (typeof EXTERNAL_SESSION_PROVIDERS)[number];

interface ExternalSessionAlias {
	provider: ExternalSessionProvider;
	id: string;
}

interface ExternalSessionImportOptions {
	homeDir?: string;
	sessionDir?: string;
	fallbackCwd?: string;
}

interface ExternalSessionImportResult {
	path: string;
	cwd: string;
	id: string;
	provider: ExternalSessionProvider;
}

interface SourceSession {
	path: string;
	id: string;
	cwd: string;
	messages: AgentMessage[];
}

interface CodexSessionMetaPayload {
	id?: unknown;
	cwd?: unknown;
	model_provider?: unknown;
}

interface CodexJsonLine {
	timestamp?: unknown;
	type?: unknown;
	payload?: unknown;
}

interface ClaudeJsonLine {
	timestamp?: unknown;
	type?: unknown;
	cwd?: unknown;
	sessionId?: unknown;
	message?: unknown;
}

interface MessageLike {
	role?: unknown;
	content?: unknown;
}

interface TextBlockLike {
	type?: unknown;
	text?: unknown;
}

export function isExternalSessionAlias(sessionArg: string): boolean {
	return parseExternalSessionAlias(sessionArg) !== undefined;
}

export async function importExternalSessionAlias(
	sessionArg: string,
	options: ExternalSessionImportOptions = {},
): Promise<ExternalSessionImportResult | undefined> {
	const alias = parseExternalSessionAlias(sessionArg);
	if (!alias) return undefined;

	const source = findSourceSession(alias, options.homeDir ?? homedir(), options.fallbackCwd ?? process.cwd());
	if (!source) return undefined;

	const sessionId = `${alias.provider}-${source.id}`;
	const destinationDir = options.sessionDir ? resolvePath(options.sessionDir) : getDefaultSessionDir(source.cwd);
	const destinationPath = join(destinationDir, `${sanitizeFileName(sessionId)}.jsonl`);
	if (!existsSync(destinationPath)) {
		writeImportedSession(destinationPath, sessionId, source);
	}

	return { path: destinationPath, cwd: source.cwd, id: sessionId, provider: alias.provider };
}

function parseExternalSessionAlias(sessionArg: string): ExternalSessionAlias | undefined {
	const separatorIndex = sessionArg.indexOf("/");
	if (separatorIndex === -1) return undefined;

	const provider = sessionArg.slice(0, separatorIndex);
	const id = sessionArg.slice(separatorIndex + 1);
	if (!isExternalSessionProvider(provider) || id.length === 0 || id.includes("/")) return undefined;

	return { provider, id };
}

function isExternalSessionProvider(value: string): value is ExternalSessionProvider {
	return EXTERNAL_SESSION_PROVIDERS.some((provider) => provider === value);
}

function findSourceSession(
	alias: ExternalSessionAlias,
	homeDir: string,
	fallbackCwd: string,
): SourceSession | undefined {
	const root = alias.provider === "codex" ? join(homeDir, ".codex", "sessions") : join(homeDir, ".claude", "projects");
	for (const filePath of listJsonlFiles(root)) {
		if (!fileNameMatchesAlias(filePath, alias)) continue;

		const source =
			alias.provider === "codex"
				? readCodexSession(filePath, fallbackCwd)
				: readClaudeSession(filePath, fallbackCwd);
		if (source && (source.id === alias.id || source.id.startsWith(alias.id))) return source;
	}
	return undefined;
}

function fileNameMatchesAlias(path: string, alias: ExternalSessionAlias): boolean {
	const fileName = basename(path, ".jsonl");
	return fileName === alias.id || fileName.endsWith(`-${alias.id}`) || fileName.includes(alias.id);
}

function listJsonlFiles(root: string): string[] {
	if (!existsSync(root)) return [];

	const files: string[] = [];
	const pending = [root];
	while (pending.length > 0) {
		const dir = pending.pop();
		if (!dir) continue;

		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				pending.push(path);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				files.push(path);
			}
		}
	}
	return files;
}

function readCodexSession(path: string, fallbackCwd: string): SourceSession | undefined {
	const lines = readJsonLines<CodexJsonLine>(path);
	const meta = lines.find((line) => line.type === "session_meta");
	const payload = isRecord(meta?.payload) ? (meta.payload as CodexSessionMetaPayload) : undefined;
	const id = stringOrUndefined(payload?.id) ?? findIdInCodexFileName(path);
	if (!id) return undefined;

	const cwd = stringOrUndefined(payload?.cwd) ?? fallbackCwd;
	const messages = lines.flatMap((line) => codexLineToMessage(line));
	return { path, id, cwd, messages };
}

function readClaudeSession(path: string, fallbackCwd: string): SourceSession | undefined {
	const lines = readJsonLines<ClaudeJsonLine>(path);
	const fileId = basename(path, ".jsonl");
	const id = lines.map((line) => stringOrUndefined(line.sessionId)).find((value) => value !== undefined) ?? fileId;
	const cwd = lines.map((line) => stringOrUndefined(line.cwd)).find((value) => value !== undefined) ?? fallbackCwd;
	const messages = lines.flatMap((line) => claudeLineToMessage(line));
	return { path, id, cwd, messages };
}

function readJsonLines<T>(path: string): T[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.flatMap((line) => parseJsonLine<T>(line));
}

function parseJsonLine<T>(line: string): T[] {
	try {
		return [JSON.parse(line) as T];
	} catch {
		return [];
	}
}

function codexLineToMessage(line: CodexJsonLine): AgentMessage[] {
	if (line.type !== "response_item" || !isRecord(line.payload)) return [];
	const payload = line.payload as MessageLike & { type?: unknown };
	if (payload.type !== "message") return [];

	return messageLikeToAgentMessages(payload, stringOrUndefined(line.timestamp), "codex");
}

function claudeLineToMessage(line: ClaudeJsonLine): AgentMessage[] {
	if (!isRecord(line.message)) return [];
	return messageLikeToAgentMessages(line.message as MessageLike, stringOrUndefined(line.timestamp), "claude");
}

function messageLikeToAgentMessages(
	message: MessageLike,
	timestamp: string | undefined,
	provider: string,
): AgentMessage[] {
	const content = normalizeTextContent(message.content);
	if (content.length === 0) return [];

	const unixTimestamp = timestamp ? new Date(timestamp).getTime() : Date.now();
	if (message.role === "user") {
		return [{ role: "user", content, timestamp: unixTimestamp } satisfies UserMessage];
	}
	if (message.role === "assistant") {
		return [
			{
				role: "assistant",
				content,
				api: provider,
				provider,
				model: "imported-session",
				usage: zeroUsage(),
				stopReason: "stop",
				timestamp: unixTimestamp,
			} satisfies AssistantMessage,
		];
	}
	return [];
}

function normalizeTextContent(content: unknown): TextContent[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];

	return content.flatMap((block) => {
		if (!isRecord(block)) return [];
		const textBlock = block as TextBlockLike;
		if (!isTextBlockType(textBlock.type) || typeof textBlock.text !== "string") return [];
		return [{ type: "text", text: textBlock.text } satisfies TextContent];
	});
}

function isTextBlockType(type: unknown): boolean {
	return type === "text" || type === "input_text" || type === "output_text";
}

function writeImportedSession(path: string, sessionId: string, source: SourceSession): void {
	mkdirSync(dirname(path), { recursive: true });
	const entries: FileEntry[] = [
		{
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: sessionId,
			timestamp: new Date().toISOString(),
			cwd: source.cwd,
			parentSession: source.path,
		},
	];

	let parentId: string | null = null;
	for (const message of source.messages) {
		const id = randomUUID().slice(0, 8);
		entries.push({
			type: "message",
			id,
			parentId,
			timestamp: new Date(message.timestamp ?? Date.now()).toISOString(),
			message,
		});
		parentId = id;
	}

	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function findIdInCodexFileName(path: string): string | undefined {
	const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9._-]+)\.jsonl$/.exec(
		basename(path),
	);
	return match?.[1];
}

function sanitizeFileName(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}
