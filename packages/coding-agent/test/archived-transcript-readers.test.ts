import { constants as bufferConstants } from "node:buffer";
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdCompress } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { exportFromFile } from "../src/core/export-html/index.ts";
import { archivePersistedSession, restoreArchivedSession } from "../src/core/session-archive-storage.ts";
import { getControlDbPath } from "../src/core/session-control-db.ts";
import { loadEntriesFromFile, readSessionHeader, SessionManager } from "../src/core/session-manager.ts";
import { createSearchCurrentSessionHistoryToolDefinition } from "../src/core/tools/search-current-session-history.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-archive-readers-"));
	roots.push(root);
	const manager = SessionManager.create(root, root);
	const db = getControlDbPath(root);
	manager.setMetadataControlDbPath(db);
	manager.appendMessage({ role: "user", content: "archive needle café 🧭", timestamp: 1 });
	manager.persistForRecovery();
	manager.setSessionGoalJson('{"objective":"preserve archived goal"}');
	const file = manager.getSessionFile()!;
	const entries = loadEntriesFromFile(file);
	const header = readSessionHeader(file);
	const archived = archivePersistedSession(db, file);
	return { root, db, file, archived, entries, header };
}

describe("archived transcript readers", () => {
	it("loads archived transcripts exceeding Node's maximum string length", async () => {
		const f = fixture();
		const archive = join(f.root, "large.jsonl.zst");
		const padding = Buffer.alloc(16 * 1024 * 1024);
		function* chunks() {
			yield Buffer.from(`${JSON.stringify(f.header)}\n`);
			for (let size = 0; size <= bufferConstants.MAX_STRING_LENGTH; size += padding.length) {
				yield padding;
				yield Buffer.from("\n");
			}
			yield Buffer.from(`${JSON.stringify(f.entries[1])}\n`);
		}
		await pipeline(Readable.from(chunks()), createZstdCompress(), createWriteStream(archive));
		expect(readSessionHeader(archive)).toEqual(f.header);
		expect(loadEntriesFromFile(archive)).toEqual(f.entries);
	}, 30000);
	it("opens legacy exports without a cwd without modifying the source", () => {
		const f = fixture();
		const path = join(f.root, "legacy.jsonl");
		const text = `${JSON.stringify({ type: "session", id: "legacy", timestamp: "2020-01-01T00:00:00Z" })}\n`;
		writeFileSync(path, text);
		expect(SessionManager.openReadOnly(path).getCwd()).toBe(process.cwd());
		expect(readFileSync(path, "utf8")).toBe(text);
	});
	it("opens archived sessions read-only for viewers and history search", async () => {
		const f = fixture();
		const manager = SessionManager.openReadOnly(f.archived);
		expect(manager.getHeader()).toEqual(f.header);
		expect(manager.getEntries()).toEqual(f.entries.slice(1));
		const tool = createSearchCurrentSessionHistoryToolDefinition();
		const result = await tool.execute("archive-history", { query: "needle" }, undefined, undefined, {
			sessionManager: manager,
		} as unknown as Parameters<typeof tool.execute>[4]);
		expect(result.details?.entries).toEqual([expect.objectContaining({ content: "archive needle café 🧭" })]);
		expect(existsSync(f.file)).toBe(false);
	});
	it("reads the same header and entries without restoring the file", () => {
		const f = fixture();
		expect(readSessionHeader(f.archived)).toEqual(f.header);
		expect(loadEntriesFromFile(f.archived)).toEqual(f.entries);
		expect(loadEntriesFromFile(f.file)).toEqual(f.entries);
		expect(() => SessionManager.open(f.file)).toThrow("restore");
		expect(existsSync(f.file)).toBe(false);
	});
	it("forks from a compressed source without unarchiving it", () => {
		const f = fixture();
		const fork = SessionManager.forkFrom(f.archived, f.root, f.root);
		fork.setMetadataControlDbPath(f.db);
		expect(fork.getSessionGoalJsonForSession(f.file)).toBe('{"objective":"preserve archived goal"}');
		expect(fork.getBranch().map((e) => (e.type === "message" ? e.message : null))).toEqual(
			f.entries.slice(1).map((e) => (e.type === "message" ? e.message : null)),
		);
		expect(existsSync(f.file)).toBe(false);
	});
	it("exports archived HTML without restoring or changing archive state", async () => {
		const f = fixture();
		const output = join(f.root, "archive.html");
		await exportFromFile(f.archived, output);
		const encoded = /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(
			readFileSync(output, "utf8"),
		)?.[1];
		expect(encoded).toBeDefined();
		expect(JSON.parse(Buffer.from(encoded!, "base64").toString("utf8")).entries).toEqual(f.entries.slice(1));
		expect(existsSync(f.file)).toBe(false);
	});
	it.each([false, true])(
		"returns the same history matches before and after archive/resume (old reference=%s)",
		async (oldReference) => {
			const f = fixture();
			const tool = createSearchCurrentSessionHistoryToolDefinition();
			const search = (manager: SessionManager) =>
				tool.execute("history", { query: "needle" }, undefined, undefined, {
					sessionManager: manager,
				} as unknown as Parameters<typeof tool.execute>[4]);
			const plain = join(f.root, "comparison.jsonl");
			writeFileSync(plain, `${f.entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
			const expected = await search(SessionManager.open(plain));
			const resumed = SessionManager.open(restoreArchivedSession(f.db, oldReference ? f.file : f.archived));
			expect(await search(resumed)).toEqual(expected);
		},
	);
});
