import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { filterAndSortSessions } from "../src/modes/interactive/components/session-selector-search.ts";

function makeSession(
	overrides: Partial<SessionInfo> & { id: string; modified: Date; firstMessage: string },
): SessionInfo {
	return {
		path: `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "",
		name: overrides.name,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified,
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage,
	};
}

describe("session selector search", () => {
	it("filters by quoted phrase with whitespace normalization", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "a",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				firstMessage: "node\n\n   cve was discussed",
			}),
			makeSession({
				id: "b",
				modified: new Date("2026-01-02T00:00:00.000Z"),
				firstMessage: "node something else",
			}),
		];

		const result = filterAndSortSessions(sessions, '"node cve"', "recent");
		expect(result.map((s) => s.id)).toEqual(["a"]);
	});

	it("filters by regex (re:) and is case-insensitive", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "a",
				modified: new Date("2026-01-02T00:00:00.000Z"),
				firstMessage: "Brave is great",
			}),
			makeSession({
				id: "b",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				firstMessage: "bravery is not the same",
			}),
		];

		const result = filterAndSortSessions(sessions, "re:\\bbrave\\b", "recent");
		expect(result.map((s) => s.id)).toEqual(["a"]);
	});

	it("recent sort preserves input order", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "newer",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				firstMessage: "brave",
			}),
			makeSession({
				id: "older",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				firstMessage: "brave",
			}),
			makeSession({
				id: "nomatch",
				modified: new Date("2026-01-04T00:00:00.000Z"),
				firstMessage: "something else",
			}),
		];

		const result = filterAndSortSessions(sessions, '"brave"', "recent");
		expect(result.map((s) => s.id)).toEqual(["newer", "older"]);
	});

	it("ranks literal matches first while preserving recent order within each group", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "candidate-a",
				modified: new Date("2026-01-04T00:00:00.000Z"),
				firstMessage: "could help arrange indexing results",
			}),
			makeSession({
				id: "candidate-b",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				firstMessage: "my computer chair broke",
			}),
			makeSession({
				id: "candidate-c",
				modified: new Date("2026-01-02T00:00:00.000Z"),
				firstMessage: "could help arrange internal records",
			}),
			makeSession({
				id: "candidate-d",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				firstMessage: "replacement chair ordered",
			}),
		];

		const result = filterAndSortSessions(sessions, "chair", "recent");
		expect(result.map((session) => session.id)).toEqual(["candidate-b", "candidate-d", "candidate-a", "candidate-c"]);
	});

	it("ranks the complete plain query before separated literal tokens", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "separated-tokens",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				firstMessage: "foo elsewhere bar",
			}),
			makeSession({
				id: "complete-query",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				firstMessage: "xxxxxxxxxxxxxxxx foo bar",
			}),
		];

		const recent = filterAndSortSessions(sessions, "foo bar", "recent");
		expect(recent.map((session) => session.id)).toEqual(["complete-query", "separated-tokens"]);

		const relevance = filterAndSortSessions(sessions, "foo bar", "relevance");
		expect(relevance.map((session) => session.id)).toEqual(["complete-query", "separated-tokens"]);
	});

	it("preserves recent ordering for mixed phrase and fuzzy-token queries", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "candidate-a",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				firstMessage: "alpha could help arrange indexing results",
			}),
			makeSession({
				id: "candidate-b",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				firstMessage: "alpha chair",
			}),
		];

		const result = filterAndSortSessions(sessions, '"alpha" chair', "recent");
		expect(result.map((session) => session.id)).toEqual(["candidate-a", "candidate-b"]);
	});

	it("relevance sort orders by score and tie-breaks by modified desc", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "late",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				firstMessage: "xxxx brave",
			}),
			makeSession({
				id: "early",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				firstMessage: "brave xxxx",
			}),
		];

		const result1 = filterAndSortSessions(sessions, '"brave"', "relevance");
		expect(result1.map((s) => s.id)).toEqual(["early", "late"]);

		const tieSessions: SessionInfo[] = [
			makeSession({
				id: "newer",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				firstMessage: "brave",
			}),
			makeSession({
				id: "older",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				firstMessage: "brave",
			}),
		];

		const result2 = filterAndSortSessions(tieSessions, '"brave"', "relevance");
		expect(result2.map((s) => s.id)).toEqual(["newer", "older"]);
	});

	it("returns empty list for invalid regex", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "a",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				firstMessage: "brave",
			}),
		];

		const result = filterAndSortSessions(sessions, "re:(", "recent");
		expect(result).toEqual([]);
	});

	it("excludes sessions with no messages", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "empty",
				name: "Important Empty Session",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				messageCount: 0,
				firstMessage: "",
			}),
			makeSession({
				id: "normal",
				modified: new Date("2026-01-02T00:00:00.000Z"),
				firstMessage: "real conversation",
			}),
		];

		const result = filterAndSortSessions(sessions, "", "recent");
		expect(result.map((session) => session.id)).toEqual(["normal"]);
	});

	describe("name filter", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "named1",
				name: "My Project",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				firstMessage: "blueberry",
			}),
			makeSession({
				id: "named2",
				name: "Another Named",
				modified: new Date("2026-01-02T00:00:00.000Z"),
				firstMessage: "blueberry",
			}),
			makeSession({
				id: "other1",
				modified: new Date("2026-01-04T00:00:00.000Z"),
				firstMessage: "blueberry",
			}),
			makeSession({
				id: "other2",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				firstMessage: "blueberry",
			}),
		];

		it("returns all sessions when nameFilter is 'all'", () => {
			const result = filterAndSortSessions(sessions, "", "recent", "all");
			expect(result.map((session) => session.id)).toEqual(["named1", "named2", "other1", "other2"]);
		});

		it("returns only named sessions when nameFilter is 'named'", () => {
			const result = filterAndSortSessions(sessions, "", "recent", "named");
			expect(result.map((session) => session.id)).toEqual(["named1", "named2"]);
		});

		it("applies name filter before search query", () => {
			const result = filterAndSortSessions(sessions, "blueberry", "recent", "named");
			expect(result.map((session) => session.id)).toEqual(["named1", "named2"]);
		});

		it("excludes whitespace-only names from named filter", () => {
			const sessionsWithWhitespace: SessionInfo[] = [
				makeSession({
					id: "whitespace",
					name: "   ",
					modified: new Date("2026-01-01T00:00:00.000Z"),
					firstMessage: "test",
				}),
				makeSession({
					id: "empty",
					name: "",
					modified: new Date("2026-01-02T00:00:00.000Z"),
					firstMessage: "test",
				}),
				makeSession({
					id: "named",
					name: "Real Name",
					modified: new Date("2026-01-03T00:00:00.000Z"),
					firstMessage: "test",
				}),
			];

			const result = filterAndSortSessions(sessionsWithWhitespace, "", "recent", "named");
			expect(result.map((session) => session.id)).toEqual(["named"]);
		});
	});
});
