import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	createSearchCurrentSessionHistoryToolDefinition,
	createSearchParentSessionHistoryToolDefinition,
} from "../src/core/tools/search-current-session-history.ts";

const directories: string[] = [];
const base = Date.parse("2026-01-01T00:00:00.000Z");
const timestamp = (minute: number) => new Date(base + minute * 60_000).toISOString();

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createFixture(count: number) {
	const directory = mkdtempSync(join(tmpdir(), "pi-history-bounds-"));
	directories.push(directory);
	const manager = SessionManager.create("/repo", join(directory, "sessions"));
	const ids = Array.from({ length: count }, (_, index) =>
		manager.appendMessage({ role: "user", content: `needle ${index}`, timestamp: 1 }),
	);
	manager.branch(ids[0]);
	manager.appendMessage({ role: "user", content: "needle inactive", timestamp: 1 });
	manager.branch(ids[count - 1]);
	manager.appendMessage({ role: "user", content: "active branch end", timestamp: 1 });
	manager.persistForRecovery();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Expected persisted session");
	const indices = new Map(ids.map((id, index) => [id, index]));
	const lines = readFileSync(file, "utf8").trimEnd().split("\n");
	writeFileSync(
		file,
		`${lines
			.map((line) => {
				const entry = JSON.parse(line) as { id?: string; timestamp?: string };
				const index = entry.id === undefined ? undefined : indices.get(entry.id);
				if (index !== undefined) entry.timestamp = timestamp(index);
				return JSON.stringify(entry);
			})
			.join("\n")}\n`,
	);
	return { manager: SessionManager.open(file), file, ids };
}

type Tool = ReturnType<typeof createSearchCurrentSessionHistoryToolDefinition>;
type Params = Parameters<Tool["execute"]>[1];

function makeSearch(kind: "current" | "parent", fixture: ReturnType<typeof createFixture>) {
	const tool =
		kind === "current"
			? createSearchCurrentSessionHistoryToolDefinition()
			: createSearchParentSessionHistoryToolDefinition();
	const context =
		kind === "current"
			? { sessionManager: fixture.manager }
			: {
					multiAgentAgentId: "child",
					multiAgentStore: { getPersistenceTarget: () => ({ sessionPath: fixture.file }) },
				};
	return (params: Params) =>
		tool.execute("history", params, undefined, undefined, context as unknown as Parameters<Tool["execute"]>[4]);
}

function contents(result: Awaited<ReturnType<ReturnType<typeof makeSearch>>>) {
	return result.details?.entries.filter((entry) => entry.matched).map((entry) => entry.content);
}

describe.each(["current", "parent"] as const)("%s session history date bounds", (kind) => {
	it("applies inclusive since and until bounds, and preserves unbounded ordering", async () => {
		const search = makeSearch(kind, createFixture(6));
		const cases = [
			{ params: {}, expected: [0, 1, 2, 3, 4, 5] },
			{ params: { since: timestamp(3) }, expected: [5, 4, 3] },
			{ params: { until: timestamp(2) }, expected: [2, 1, 0] },
			{ params: { since: timestamp(2), until: timestamp(4) }, expected: [4, 3, 2] },
			{ params: { since: "2026-01-01T01:02:00+01:00", until: "2025-12-31T19:04:00-05:00" }, expected: [4, 3, 2] },
		];
		for (const { params, expected } of cases) {
			const result = await search({ query: "needle", ...params });
			expect(result.details?.totalMatches).toBe(expected.length);
			expect(contents(result)).toEqual(expected.map((index) => `needle ${index}`));
		}
	});

	it("filters before default and maximum limits and paginates bounded matches", async () => {
		const search = makeSearch(kind, createFixture(75));
		const params = { query: "needle", since: timestamp(10), until: timestamp(70) };
		const first = await search(params);
		expect(first.details?.totalMatches).toBe(61);
		expect(first.details?.returnedMatches).toBe(20);
		expect(contents(first)).toEqual(Array.from({ length: 20 }, (_, i) => `needle ${70 - i}`));
		const large = await search({ ...params, limit: 50 });
		expect(large.details?.returnedMatches).toBe(50);
		expect(contents(large)).toEqual(Array.from({ length: 50 }, (_, i) => `needle ${70 - i}`));
		const capped = await search({ ...params, limit: 100 });
		expect(capped.details?.returnedMatches).toBe(50);
		const cursor = large.details?.nextCursor;
		expect(cursor).toBeDefined();
		const last = await search({ ...params, limit: 50, cursor });
		expect(contents(last)).toEqual(Array.from({ length: 11 }, (_, i) => `needle ${20 - i}`));
		expect(last.details?.nextCursor).toBeUndefined();
		const equivalent = await search({ ...params, since: "2026-01-01T01:10:00+01:00", limit: 50, cursor });
		expect(contents(equivalent)).toEqual(contents(last));
		await expect(search({ query: "needle", cursor })).rejects.toThrow();
		await expect(search({ ...params, cursor: "1" })).rejects.toThrow();
		await expect(search({ ...params, query: "different", cursor })).rejects.toThrow();
		await expect(search({ ...params, since: timestamp(11), cursor })).rejects.toThrow();
		await expect(search({ ...params, until: timestamp(69), cursor })).rejects.toThrow();
		const old = await search({ query: "needle", limit: 2, cursor: "1" });
		expect(contents(old)).toEqual(["needle 1", "needle 2"]);
		expect(old.details?.nextCursor).toBe("3");
	});

	it("keeps neighboring context inside the bounds", async () => {
		const search = makeSearch(kind, createFixture(6));
		const result = await search({ query: "needle 2", since: timestamp(2), until: timestamp(3), context_entries: 2 });
		expect(result.details?.entries.map((entry) => entry.content).sort()).toEqual(["needle 2", "needle 3"]);
	});

	it("rejects invalid timestamps and reversed ranges", async () => {
		const search = makeSearch(kind, createFixture(3));
		for (const invalid of [
			"not-a-date",
			"2026-01-01",
			"2026-01-01T00:00:00",
			"2026-02-30T00:00:00Z",
			"2026-13-01T00:00:00Z",
		]) {
			await expect(search({ query: "needle", since: invalid })).rejects.toThrow();
			await expect(search({ query: "needle", until: invalid })).rejects.toThrow();
		}
		await expect(search({ query: "needle", since: timestamp(2), until: timestamp(1) })).rejects.toThrow();
	});
});

it("does not permit parent searches without child identity and a persisted parent", async () => {
	const fixture = createFixture(2);
	const tool = createSearchParentSessionHistoryToolDefinition();
	const params = { query: "needle", since: timestamp(0) };
	const context = (value: unknown) => value as Parameters<Tool["execute"]>[4];
	await expect(
		tool.execute(
			"history",
			params,
			undefined,
			undefined,
			context({ multiAgentStore: { getPersistenceTarget: () => ({ sessionPath: fixture.file }) } }),
		),
	).rejects.toThrow();
	await expect(
		tool.execute("history", params, undefined, undefined, context({ multiAgentAgentId: "child" })),
	).rejects.toThrow();
});
