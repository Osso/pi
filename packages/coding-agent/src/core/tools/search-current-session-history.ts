import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import type { SessionEntry } from "../session-manager.ts";

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
	searchText: string;
}

function searchableEntry(entry: SessionEntry): SearchableSessionEntry | undefined {
	switch (entry.type) {
		case "message":
			return {
				entry,
				role: entry.message.role,
				content: "content" in entry.message ? entry.message.content : entry.message,
				searchText: JSON.stringify(entry.message),
			};
		case "custom_message":
			return {
				entry,
				role: "custom",
				content: entry.content,
				searchText: JSON.stringify(entry.content),
			};
		case "compaction":
			return { entry, role: "compaction", content: entry.summary, searchText: entry.summary };
		case "branch_summary":
			return { entry, role: "branchSummary", content: entry.summary, searchText: entry.summary };
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

function selectedIndexes(matchIndexes: number[], contextEntries: number, entryCount: number): Set<number> {
	const indexes = new Set<number>();
	for (const matchIndex of matchIndexes) {
		const firstIndex = Math.max(0, matchIndex - contextEntries);
		const lastIndex = Math.min(entryCount - 1, matchIndex + contextEntries);
		for (let index = firstIndex; index <= lastIndex; index += 1) {
			indexes.add(index);
		}
	}
	return indexes;
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
			"Search the current persisted session's active branch, including full entries hidden from model context by compaction.",
		promptSnippet: "Search the current stored session history after compaction",
		promptGuidelines: [
			"Use search_current_session_history to recover details from the current session that may have been omitted by compaction.",
			"Searches only the current active branch and returns full matching content with optional neighboring entries.",
		],
		parameters: searchCurrentSessionHistorySchema,
		executionMode: "parallel",
		async execute(_toolCallId, params, _signal, _onUpdate, rawContext) {
			const ctx = requirePersistedSession(rawContext);
			const query = params.query.trim();
			if (query === "") {
				throw new Error("search_current_session_history query must not be empty");
			}

			const branch = ctx.sessionManager.getBranch();
			const searchableEntries = branch.flatMap((entry) => {
				const searchable = searchableEntry(entry);
				return searchable ? [searchable] : [];
			});
			const normalizedQuery = query.toLocaleLowerCase();
			const allMatchIndexes = searchableEntries.flatMap((entry, index) =>
				entry.searchText.toLocaleLowerCase().includes(normalizedQuery) ? [index] : [],
			);
			const cursor = parseCursor(params.cursor);
			const limit = params.limit ?? DEFAULT_LIMIT;
			const pageMatchIndexes = allMatchIndexes.slice(cursor, cursor + limit);
			const contextEntries = params.context_entries ?? 0;
			const includedIndexes = selectedIndexes(pageMatchIndexes, contextEntries, searchableEntries.length);
			const matchIndexSet = new Set(pageMatchIndexes);
			const contextEntryIds = new Set(ctx.sessionManager.buildContextEntries().map((entry) => entry.id));
			const entries = searchableEntries.flatMap((searchable, index): SessionHistorySearchEntry[] => {
				if (!includedIndexes.has(index)) return [];
				return [
					{
						id: searchable.entry.id,
						timestamp: searchable.entry.timestamp,
						entryType: searchable.entry.type as SessionHistorySearchEntry["entryType"],
						role: searchable.role,
						content: searchable.content,
						matched: matchIndexSet.has(index),
						compacted: !contextEntryIds.has(searchable.entry.id),
					},
				];
			});
			const nextOffset = cursor + pageMatchIndexes.length;
			const nextCursor = nextOffset < allMatchIndexes.length ? String(nextOffset) : undefined;
			const details: SearchCurrentSessionHistoryToolDetails = {
				query,
				totalMatches: allMatchIndexes.length,
				returnedMatches: pageMatchIndexes.length,
				nextCursor,
				entries,
			};
			const text =
				allMatchIndexes.length === 0
					? "No matches found in current session history."
					: JSON.stringify(details, null, 2);
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
