import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { readSessionHistoryReverse } from "../session-history.ts";
import type { ReadonlySessionManager, SessionEntry } from "../session-manager.ts";

const DEFAULT_LIMIT = 20;

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
		Type.Integer({ description: "Maximum matching entries to return. Defaults to 20.", minimum: 1, maximum: 50 }),
	),
	cursor: Type.Optional(Type.String({ description: "Pagination cursor returned by a previous search." })),
});

export type SearchCurrentSessionHistoryToolInput = Static<typeof searchCurrentSessionHistorySchema>;

export interface SessionHistorySearchEntry {
	id: string;
	timestamp: string;
	entryType: "message" | "custom_message" | "compaction" | "branch_summary";
	role: string;
	content: unknown;
	matched: boolean;
	compacted: boolean;
}

export interface SearchCurrentSessionHistoryToolDetails {
	query: string;
	totalMatches: number;
	returnedMatches: number;
	nextCursor: string | undefined;
	entries: SessionHistorySearchEntry[];
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
				return block.name === "search_current_session_history"
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
			return message.toolName === "search_current_session_history" ? [] : collectSearchTexts(message.content);
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

function parseCursor(cursor: string | undefined): number {
	if (cursor === undefined) return 0;
	if (!/^\d+$/.test(cursor)) {
		throw new Error("search_current_session_history cursor must be a non-negative integer cursor");
	}
	return Number(cursor);
}

async function* readSearchableHistoryReverse(manager: ReadonlySessionManager, query: string) {
	for await (const entry of readSessionHistoryReverse(manager)) {
		const searchable = searchableEntry(entry);
		if (!searchable) continue;
		const matches = searchable.searchTexts.some((text) => text.toLocaleLowerCase().includes(query));
		yield { ...searchable, matches };
	}
}

async function readHistoryPage(
	manager: ReadonlySessionManager,
	query: string,
	totalMatches: number,
	params: SearchCurrentSessionHistoryToolInput,
): Promise<SessionHistorySearchEntry[]> {
	const cursor = parseCursor(params.cursor);
	const limit = params.limit ?? DEFAULT_LIMIT;
	const contextEntries = params.context_entries ?? 0;
	const contextIds = new Set(manager.buildContextEntries().map((entry) => entry.id));
	const included = new Map<number, SessionHistorySearchEntry>();
	const neighbors: { index: number; entry: SessionHistorySearchEntry }[] = [];
	let matchOffset = totalMatches;
	let remainingContext = 0;
	let index = 0;
	for await (const searchable of readSearchableHistoryReverse(manager, query)) {
		if (searchable.matches) matchOffset--;
		const matched = searchable.matches && matchOffset >= cursor && matchOffset < cursor + limit;
		const entry: SessionHistorySearchEntry = {
			id: searchable.entry.id,
			timestamp: searchable.entry.timestamp,
			entryType: searchable.entry.type as SessionHistorySearchEntry["entryType"],
			role: searchable.role,
			content: searchable.content,
			matched,
			compacted: !contextIds.has(searchable.entry.id),
		};
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
	return [...included].sort(([left], [right]) => right - left).map(([, entry]) => entry);
}

function requirePersistedSession(ctx: ExtensionContext | undefined): ExtensionContext {
	if (!ctx?.sessionManager.getSessionFile()) {
		throw new Error("search_current_session_history requires a persisted current session");
	}
	return ctx;
}

export function createSearchCurrentSessionHistoryToolDefinition(): ToolDefinition<
	typeof searchCurrentSessionHistorySchema,
	SearchCurrentSessionHistoryToolDetails
> {
	return {
		name: "search_current_session_history",
		label: "search_current_session_history",
		description:
			"Search conversational content in the current persisted session's active branch, including full entries hidden from model context by compaction.",
		promptSnippet: "Search the current stored session history after compaction",
		promptGuidelines: [
			"Use search_current_session_history to recover details from the current session that may have been omitted by compaction.",
			"Matching includes user and assistant text, tool-call names and arguments, tool results, custom messages, and summaries; excludes thinking, signatures, and this tool's own calls and results.",
		],
		parameters: searchCurrentSessionHistorySchema,
		executionMode: "parallel",
		async execute(_toolCallId, params, _signal, _onUpdate, rawContext) {
			const ctx = requirePersistedSession(rawContext);
			const query = params.query.trim();
			if (query === "") {
				throw new Error("search_current_session_history query must not be empty");
			}

			const cursor = parseCursor(params.cursor);
			const normalizedQuery = query.toLocaleLowerCase();
			let totalMatches = 0;
			for await (const searchable of readSearchableHistoryReverse(ctx.sessionManager, normalizedQuery)) {
				if (searchable.matches) totalMatches++;
			}
			const returnedMatches = Math.min(params.limit ?? DEFAULT_LIMIT, Math.max(0, totalMatches - cursor));
			const entries =
				returnedMatches > 0 ? await readHistoryPage(ctx.sessionManager, normalizedQuery, totalMatches, params) : [];
			const nextOffset = cursor + returnedMatches;
			const nextCursor = nextOffset < totalMatches ? String(nextOffset) : undefined;
			const details: SearchCurrentSessionHistoryToolDetails = {
				query,
				totalMatches,
				returnedMatches,
				nextCursor,
				entries,
			};
			const text =
				totalMatches === 0 ? "No matches found in current session history." : JSON.stringify(details, null, 2);
			return { content: [{ type: "text", text }], details };
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				`${theme.fg("toolTitle", theme.bold("search_current_session_history"))} ${theme.fg("accent", JSON.stringify(args?.query ?? ""))}`,
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
