import { fuzzyMatch } from "@earendil-works/pi-tui";
import type { SessionInfo } from "../../../core/session-manager.ts";

export type SortMode = "threaded" | "recent" | "relevance";

export type NameFilter = "all" | "named";

export interface ParsedSearchQuery {
	mode: "tokens" | "regex";
	tokens: { kind: "fuzzy" | "phrase"; value: string }[];
	regex: RegExp | null;
	/** If set, parsing failed and we should treat query as non-matching. */
	error?: string;
}

export interface MatchResult {
	matches: boolean;
	/** True when every token matched as a literal substring rather than only as a subsequence. */
	literal: boolean;
	/** Lower is better; only meaningful when matches === true */
	score: number;
}

function normalizeWhitespaceLower(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function getSessionSearchText(session: SessionInfo): string {
	return `${session.id} ${session.name ?? ""} ${session.allMessagesText} ${session.cwd}`;
}

export function hasSessionName(session: SessionInfo): boolean {
	return Boolean(session.name?.trim());
}

export function hasSessionMessages(session: SessionInfo): boolean {
	return session.messageCount > 0;
}

function matchesNameFilter(session: SessionInfo, filter: NameFilter): boolean {
	if (!hasSessionMessages(session)) return false;
	if (filter === "all") return true;
	return hasSessionName(session);
}

export function parseSearchQuery(query: string): ParsedSearchQuery {
	const trimmed = query.trim();
	if (!trimmed) {
		return { mode: "tokens", tokens: [], regex: null };
	}

	// Regex mode: re:<pattern>
	if (trimmed.startsWith("re:")) {
		const pattern = trimmed.slice(3).trim();
		if (!pattern) {
			return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
		}
		try {
			return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { mode: "regex", tokens: [], regex: null, error: msg };
		}
	}

	// Token mode with quote support.
	// Example: foo "node cve" bar
	const tokens: { kind: "fuzzy" | "phrase"; value: string }[] = [];
	let buf = "";
	let inQuote = false;
	let hadUnclosedQuote = false;

	const flush = (kind: "fuzzy" | "phrase"): void => {
		const v = buf.trim();
		buf = "";
		if (!v) return;
		tokens.push({ kind, value: v });
	};

	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i]!;
		if (ch === '"') {
			if (inQuote) {
				flush("phrase");
				inQuote = false;
			} else {
				flush("fuzzy");
				inQuote = true;
			}
			continue;
		}

		if (!inQuote && /\s/.test(ch)) {
			flush("fuzzy");
			continue;
		}

		buf += ch;
	}

	if (inQuote) {
		hadUnclosedQuote = true;
	}

	// If quotes were unbalanced, fall back to plain whitespace tokenization.
	if (hadUnclosedQuote) {
		return {
			mode: "tokens",
			tokens: trimmed
				.split(/\s+/)
				.map((t) => t.trim())
				.filter((t) => t.length > 0)
				.map((t) => ({ kind: "fuzzy" as const, value: t })),
			regex: null,
		};
	}

	flush(inQuote ? "phrase" : "fuzzy");

	return { mode: "tokens", tokens, regex: null };
}

export function matchSession(session: SessionInfo, parsed: ParsedSearchQuery): MatchResult {
	const text = getSessionSearchText(session);
	const lowerText = text.toLowerCase();

	if (parsed.mode === "regex") {
		if (!parsed.regex) {
			return { matches: false, literal: false, score: 0 };
		}
		const idx = text.search(parsed.regex);
		if (idx < 0) return { matches: false, literal: false, score: 0 };
		return { matches: true, literal: true, score: idx * 0.1 };
	}

	if (parsed.tokens.length === 0) {
		return { matches: true, literal: true, score: 0 };
	}

	let totalScore = 0;
	let literal = true;
	let normalizedText: string | null = null;

	for (const token of parsed.tokens) {
		if (token.kind === "phrase") {
			if (normalizedText === null) {
				normalizedText = normalizeWhitespaceLower(text);
			}
			const phrase = normalizeWhitespaceLower(token.value);
			if (!phrase) continue;
			const idx = normalizedText.indexOf(phrase);
			if (idx < 0) return { matches: false, literal: false, score: 0 };
			totalScore += idx * 0.1;
			continue;
		}

		const m = fuzzyMatch(token.value, text);
		if (!m.matches) return { matches: false, literal: false, score: 0 };
		totalScore += m.score;
		literal = literal && lowerText.includes(token.value.toLowerCase());
	}

	return { matches: true, literal, score: totalScore };
}

export function filterAndSortSessions(
	sessions: SessionInfo[],
	query: string,
	sortMode: SortMode,
	nameFilter: NameFilter = "all",
): SessionInfo[] {
	const nameFiltered = sessions.filter((session) => matchesNameFilter(session, nameFilter));
	const trimmed = query.trim();
	if (!trimmed) return nameFiltered;

	const parsed = parseSearchQuery(query);
	if (parsed.error) return [];

	// Recent mode: literal matches first, preserving incoming order within each group.
	if (sortMode === "recent") {
		const literalMatches: SessionInfo[] = [];
		const fuzzyMatches: SessionInfo[] = [];
		for (const session of nameFiltered) {
			const result = matchSession(session, parsed);
			if (!result.matches) continue;
			const destination = result.literal ? literalMatches : fuzzyMatches;
			destination.push(session);
		}
		return [...literalMatches, ...fuzzyMatches];
	}

	// Relevance mode: literal matches first, then score, then modified date.
	const scored: { session: SessionInfo; literal: boolean; score: number }[] = [];
	for (const session of nameFiltered) {
		const result = matchSession(session, parsed);
		if (!result.matches) continue;
		scored.push({ session, literal: result.literal, score: result.score });
	}

	scored.sort((a, b) => {
		if (a.literal !== b.literal) return a.literal ? -1 : 1;
		if (a.score !== b.score) return a.score - b.score;
		return b.session.modified.getTime() - a.session.modified.getTime();
	});

	return scored.map((r) => r.session);
}
