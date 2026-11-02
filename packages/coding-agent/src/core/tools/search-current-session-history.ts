import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { readSessionFileHistoryReverse, readSessionHistoryReverse } from "../session-history.ts";
import type { SessionEntry } from "../session-manager.ts";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const CURRENT_TOOL_NAME = "search_current_session_history";
const PARENT_TOOL_NAME = "search_parent_session_history";
const HISTORY_SEARCH_TOOL_NAMES = new Set([CURRENT_TOOL_NAME, PARENT_TOOL_NAME]);

const searchCurrentSessionHistorySchema = Type.Object({
	query: Type.String({ description: "Case-insensitive literal text to search for." }),
	context_entries: Type.Optional(
		Type.Integer({
			description: "Number of neighboring searchable entries to include before and after each match. Defaults to 0.",
			minimum: 0,
			maximum: 10,
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			description: "Maximum matching entries to return. Defaults to 20.",
			minimum: 1,
			maximum: MAX_LIMIT,
		}),
	),
	since: Type.Optional(
		Type.String({ description: "Inclusive ISO timestamp with timezone: return entries at or after this time." }),
	),
	until: Type.Optional(
		Type.String({ description: "Inclusive ISO timestamp with timezone: return entries at or before this time." }),
	),
	cursor: Type.Optional(
		Type.String({ description: "Pagination cursor returned by a previous search with the same bounds." }),
	),
});

export type SearchCurrentSessionHistoryToolInput = Static<typeof searchCurrentSessionHistorySchema>;

export interface SessionHistorySearchEntry {
	id: string;
	timestamp: string;
	entryType: "message" | "custom_message" | "compaction" | "branch_summary";
	role: string;
	content: unknown;
	matched: boolean;
	/** Whether compaction hid the entry from model context; omitted for a parent session this runtime does not load. */
	compacted?: boolean;
}

export interface SearchCurrentSessionHistoryToolDetails {
	query: string;
	totalMatches: number;
	returnedMatches: number;
	nextCursor: string | undefined;
	entries: SessionHistorySearchEntry[];
}

interface HistorySource {
	toolName: string;
	readReverse(): AsyncGenerator<SessionEntry>;
	contextEntryIds: Set<string> | undefined;
}

interface SearchableSessionEntry {
	entry: SessionEntry;
	role: string;
	content: unknown;
	searchTexts: string[];
}

function collectArgumentTexts(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (typeof value === "number" || typeof value === "boolean" || value === null) return [String(value)];
	if (Array.isArray(value)) return value.flatMap(collectArgumentTexts);
	if (value && typeof value === "object") {
		return Object.entries(value).flatMap(([key, argument]) => [key, ...collectArgumentTexts(argument)]);
	}
	return [];
}

function collectSearchTexts(content: string | (TextContent | ImageContent | ThinkingContent | ToolCall)[]): string[] {
	if (typeof content === "string") return [content];
	return content.flatMap((block) => {
		switch (block.type) {
			case "text":
				return [block.text];
			case "toolCall":
				return HISTORY_SEARCH_TOOL_NAMES.has(block.name)
					? []
					: [block.name, ...collectArgumentTexts(block.arguments)];
			default:
				return [];
		}
	});
}

function collectMessageSearchTexts(message: AgentMessage): string[] {
	switch (message.role) {
		case "toolResult":
			return HISTORY_SEARCH_TOOL_NAMES.has(message.toolName) ? [] : collectSearchTexts(message.content);
		case "bashExecution":
			return [message.command, message.output];
		case "branchSummary":
		case "compactionSummary":
			return [message.summary];
		default:
			return collectSearchTexts(message.content);
	}
}

function searchableEntry(entry: SessionEntry): SearchableSessionEntry | undefined {
	switch (entry.type) {
		case "message": {
			const content = "content" in entry.message ? entry.message.content : entry.message;
			return {
				entry,
				role: entry.message.role,
				content,
				searchTexts: collectMessageSearchTexts(entry.message),
			};
		}
		case "custom_message":
			return {
				entry,
				role: "custom",
				content: entry.content,
				searchTexts: collectSearchTexts(entry.content),
			};
		case "compaction":
			return { entry, role: "compaction", content: entry.summary, searchTexts: [entry.summary] };
		case "branch_summary":
			return { entry, role: "branchSummary", content: entry.summary, searchTexts: [entry.summary] };
		default:
			return undefined;
	}
}

interface HistorySearchOptions {
	query: string;
	since: number | undefined;
	until: number | undefined;
	newestFirst: boolean;
	limit: number;
	contextEntries: number;
	offset: number;
}

function parseTimeBound(toolName: string, name: string, value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const iso = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
	const match = iso.exec(value);
	const timestamp = Date.parse(value);
	if (!match || !Number.isFinite(timestamp)) {
		throw new Error(`${toolName} ${name} must be an ISO timestamp with a timezone`);
	}
	const calendarDay = new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10);
	if (calendarDay !== match[1]) throw new Error(`${toolName} ${name} must be a valid ISO timestamp`);
	return timestamp;
}

function cursorScope(options: HistorySearchOptions): string {
	return JSON.stringify([options.query, options.since ?? null, options.until ?? null]);
}

function parseCursor(toolName: string, cursor: string | undefined, options: HistorySearchOptions): number {
	if (cursor === undefined) return 0;
	if (!options.newestFirst) {
		const offset = Number(cursor);
		if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(offset)) {
			throw new Error(`${toolName} cursor must be a non-negative integer cursor`);
		}
		return offset;
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
	} catch {
		throw new Error(`${toolName} cursor is invalid for this bounded search`);
	}
	if (!Array.isArray(decoded) || decoded.length !== 2) {
		throw new Error(`${toolName} cursor is invalid for this bounded search`);
	}
	const [scope, offset]: unknown[] = decoded;
	const validOffset = typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0;
	if (scope !== cursorScope(options) || !validOffset) {
		throw new Error(`${toolName} cursor does not match this query and date bounds`);
	}
	return offset;
}

function parseSearchOptions(toolName: string, params: SearchCurrentSessionHistoryToolInput): HistorySearchOptions {
	const since = parseTimeBound(toolName, "since", params.since);
	const until = parseTimeBound(toolName, "until", params.until);
	if (since !== undefined && until !== undefined && since > until) {
		throw new Error(`${toolName} since must be at or before until`);
	}
	const requestedLimit = params.limit ?? DEFAULT_LIMIT;
	if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
		throw new Error(`${toolName} limit must be a positive integer`);
	}
	const options: HistorySearchOptions = {
		query: params.query.trim().toLocaleLowerCase(),
		since,
		until,
		newestFirst: since !== undefined || until !== undefined,
		limit: Math.min(requestedLimit, MAX_LIMIT),
		contextEntries: params.context_entries ?? 0,
		offset: 0,
	};
	return { ...options, offset: parseCursor(toolName, params.cursor, options) };
}

function isWithinBounds(entry: SessionEntry, options: HistorySearchOptions): boolean {
	if (!options.newestFirst) return true;
	const timestamp = Date.parse(entry.timestamp);
	const afterSince = options.since === undefined || timestamp >= options.since;
	const beforeUntil = options.until === undefined || timestamp <= options.until;
	return afterSince && beforeUntil;
}

async function* readSearchableHistoryReverse(source: HistorySource, options: HistorySearchOptions) {
	for await (const entry of source.readReverse()) {
		if (!isWithinBounds(entry, options)) continue;
		const searchable = searchableEntry(entry);
		if (!searchable) continue;
		const matches = searchable.searchTexts.some((text) => text.toLocaleLowerCase().includes(options.query));
		yield { ...searchable, matches };
	}
}

function toSearchEntry(searchable: SearchableSessionEntry, matched: boolean, source: HistorySource) {
	const entry: SessionHistorySearchEntry = {
		id: searchable.entry.id,
		timestamp: searchable.entry.timestamp,
		entryType: searchable.entry.type as SessionHistorySearchEntry["entryType"],
		role: searchable.role,
		content: searchable.content,
		matched,
	};
	if (source.contextEntryIds) entry.compacted = !source.contextEntryIds.has(searchable.entry.id);
	return entry;
}

async function readHistoryPage(
	source: HistorySource,
	options: HistorySearchOptions,
	totalMatches: number,
): Promise<SessionHistorySearchEntry[]> {
	const { offset: cursor, limit, contextEntries } = options;
	const included = new Map<number, SessionHistorySearchEntry>();
	const neighbors: { index: number; entry: SessionHistorySearchEntry }[] = [];
	let matchOffset = options.newestFirst ? -1 : totalMatches;
	const direction = options.newestFirst ? 1 : -1;
	let remainingContext = 0;
	let index = 0;
	for await (const searchable of readSearchableHistoryReverse(source, options)) {
		if (searchable.matches) matchOffset += direction;
		const matched = searchable.matches && matchOffset >= cursor && matchOffset < cursor + limit;
		const entry = toSearchEntry(searchable, matched, source);
		if (matched) {
			for (const neighbor of neighbors) included.set(neighbor.index, neighbor.entry);
			remainingContext = contextEntries + 1;
		}
		if (remainingContext > 0) {
			included.set(index, entry);
			remainingContext--;
		}
		neighbors.push({ index, entry });
		if (neighbors.length > contextEntries) neighbors.shift();
		index++;
	}
	return [...included].sort(([left], [right]) => direction * (left - right)).map(([, entry]) => entry);
}

async function searchHistory(source: HistorySource, params: SearchCurrentSessionHistoryToolInput, emptyText: string) {
	const query = params.query.trim();
	if (query === "") {
		throw new Error(`${source.toolName} query must not be empty`);
	}
	const options = parseSearchOptions(source.toolName, params);
	let totalMatches = 0;
	for await (const searchable of readSearchableHistoryReverse(source, options)) {
		if (searchable.matches) totalMatches++;
	}
	const returnedMatches = Math.min(options.limit, Math.max(0, totalMatches - options.offset));
	const entries = returnedMatches > 0 ? await readHistoryPage(source, options, totalMatches) : [];
	const nextOffset = options.offset + returnedMatches;
	const continuation = options.newestFirst
		? Buffer.from(JSON.stringify([cursorScope(options), nextOffset])).toString("base64url")
		: String(nextOffset);
	const nextCursor = nextOffset < totalMatches ? continuation : undefined;
	const details: SearchCurrentSessionHistoryToolDetails = {
		query,
		totalMatches,
		returnedMatches,
		nextCursor,
		entries,
	};
	const text = totalMatches === 0 ? emptyText : JSON.stringify(details, null, 2);
	return { content: [{ type: "text" as const, text }], details };
}

function currentSessionSource(rawContext: ExtensionContext | undefined): HistorySource {
	const sessionManager = rawContext?.sessionManager;
	if (!sessionManager?.getSessionFile()) {
		throw new Error(`${CURRENT_TOOL_NAME} requires a persisted current session`);
	}
	return {
		toolName: CURRENT_TOOL_NAME,
		readReverse: () => readSessionHistoryReverse(sessionManager),
		contextEntryIds: new Set(sessionManager.buildContextEntries().map((entry) => entry.id)),
	};
}

/** Children run in-process against the parent's multi-agent store, which persists under the parent's session file. */
function parentSessionSource(rawContext: ExtensionContext | undefined): HistorySource {
	if (!rawContext?.multiAgentAgentId) {
		throw new Error(`${PARENT_TOOL_NAME} is only available to child agents`);
	}
	const parentSessionPath = rawContext.multiAgentStore?.getPersistenceTarget()?.sessionPath;
	if (!parentSessionPath) {
		throw new Error(`${PARENT_TOOL_NAME} requires a persisted parent session`);
	}
	return {
		toolName: PARENT_TOOL_NAME,
		readReverse: () => readSessionFileHistoryReverse(parentSessionPath),
		contextEntryIds: undefined,
	};
}

type HistorySearchToolDefinition = ToolDefinition<
	typeof searchCurrentSessionHistorySchema,
	SearchCurrentSessionHistoryToolDetails
>;

function createHistorySearchRenderers(
	toolName: string,
): Pick<HistorySearchToolDefinition, "renderCall" | "renderResult"> {
	return {
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				`${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", JSON.stringify(args?.query ?? ""))}`,
			);
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

export function createSearchCurrentSessionHistoryToolDefinition(): HistorySearchToolDefinition {
	return {
		name: CURRENT_TOOL_NAME,
		label: CURRENT_TOOL_NAME,
		description:
			"Search conversational content in the current persisted session's active branch, including full entries hidden from model context by compaction.",
		promptSnippet: "Search the current stored session history after compaction",
		promptGuidelines: [
			"Use search_current_session_history to recover details from the current session that may have been omitted by compaction.",
			"Matching includes user and assistant text, tool-call names and arguments, tool results, custom messages, and summaries; excludes thinking, signatures, and history-search calls and results.",
			"Use since and/or until ISO timestamps to restrict evidence by entry time and return newest matches first; reuse the same bounds with a returned cursor.",
		],
		parameters: searchCurrentSessionHistorySchema,
		executionMode: "parallel",
		execute: async (_toolCallId, params, _signal, _onUpdate, rawContext) =>
			searchHistory(currentSessionSource(rawContext), params, "No matches found in current session history."),
		...createHistorySearchRenderers(CURRENT_TOOL_NAME),
	};
}

export function createSearchParentSessionHistoryToolDefinition(): HistorySearchToolDefinition {
	return {
		name: PARENT_TOOL_NAME,
		label: PARENT_TOOL_NAME,
		description:
			"Child agents only: read-only search of the direct parent session's persisted active branch, such as the parent's user messages, tool calls, and results.",
		promptSnippet: "Search the parent session's stored history (child agents only)",
		promptGuidelines: [
			"Use search_parent_session_history when a task needs evidence of what the parent session did or was asked; it cannot read other sessions.",
			"Matching includes user and assistant text, tool-call names and arguments, tool results, custom messages, and summaries; excludes thinking, signatures, and history-search calls and results.",
			"Use since and/or until ISO timestamps to restrict evidence by entry time and return newest matches first; reuse the same bounds with a returned cursor.",
		],
		parameters: searchCurrentSessionHistorySchema,
		executionMode: "parallel",
		execute: async (_toolCallId, params, _signal, _onUpdate, rawContext) =>
			searchHistory(parentSessionSource(rawContext), params, "No matches found in parent session history."),
		...createHistorySearchRenderers(PARENT_TOOL_NAME),
	};
}
