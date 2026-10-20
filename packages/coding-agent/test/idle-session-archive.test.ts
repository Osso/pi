import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	appendFileSync,
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import * as storage from "../src/core/idle-session-archive.ts";
import { restoreArchivedSession } from "../src/core/session-archive-storage.ts";
import {
	bootstrapMultiAgentAgent,
	getControlDbPath,
	readSessionMetadata,
	registerRuntimeMailboxListener,
	writeSessionMetadata,
} from "../src/core/session-control-db.ts";
import { loadEntriesFromFile, SessionManager } from "../src/core/session-manager.ts";

const roots: string[] = [];
const now = Date.parse("2026-10-20T12:00:00Z");
const day = 86400000;
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(age = 31) {
	const root = mkdtempSync(join(tmpdir(), "pi-idle-archive-"));
	roots.push(root);
	const dir = join(root, "sessions", "project");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "old.jsonl");
	const content = `${JSON.stringify({ type: "session", version: 3, id: "old", cwd: root, timestamp: "2026-09-01T00:00:00Z" })}\n${JSON.stringify({ type: "message", id: "one", parentId: null, timestamp: "2026-09-01T00:00:01Z", message: { role: "user", content: "needle cobalt café 🧭", timestamp: 1 } })}\n`;
	writeFileSync(file, content, { mode: 0o600 });
	utimesSync(file, new Date(now - age * day), new Date(now - age * day));
	const db = getControlDbPath(root);
	writeSessionMetadata(db, {
		sessionPath: file,
		id: "old",
		cwd: root,
		createdAt: "2026-09-01T00:00:00Z",
		modifiedAt: "2026-09-01T00:00:01Z",
		messageCount: 1,
		firstMessage: "needle cobalt café 🧭",
	});
	return { root, dir, file, content, db };
}

type CrashPoint = "after-link" | "before-unlink" | "after-unlink";
const crashPoints: CrashPoint[] = ["after-link", "before-unlink", "after-unlink"];

function crashArchive(point: CrashPoint) {
	const f = fixture();
	const child = spawnSync(
		process.execPath,
		[
			"--import",
			import.meta.resolve("tsx"),
			new URL("./fixtures/idle-archive-crash.ts", import.meta.url).pathname,
			f.root,
			f.file,
			f.db,
			point,
			String(now),
		],
		{ encoding: "utf8", timeout: 15000 },
	);
	expect(child.signal, child.stderr).toBe("SIGKILL");
	expect(existsSync(f.file)).toBe(point !== "after-unlink");
	expect(zstdDecompressSync(readFileSync(`${f.file}.zst`))).toEqual(Buffer.from(f.content));
	const dbPath = point === "after-link" ? f.file : `${f.file}.zst`;
	expect(readSessionMetadata(f.db, dbPath)).toMatchObject({ id: "old", isArchived: point !== "after-link" });
	expect(readSessionMetadata(f.db, point === "after-link" ? `${f.file}.zst` : f.file)).toBeUndefined();
	return f;
}

function assertWritableRestore(f: ReturnType<typeof fixture>, input: string, content = f.content) {
	const restored = restoreArchivedSession(f.db, input);
	expect(restored).toBe(f.file);
	expect(readFileSync(restored, "utf8")).toBe(content);
	expect(existsSync(`${f.file}.zst`)).toBe(false);
	expect(readSessionMetadata(f.db, `${f.file}.zst`)).toBeUndefined();
	expect(readSessionMetadata(f.db, restored)).toMatchObject({ id: "old", isArchived: false });
	const manager = SessionManager.open(restored);
	manager.setMetadataControlDbPath(f.db);
	manager.appendMessage({ role: "user", content: "post-restore append", timestamp: 2 });
	manager.persistForRecovery();
	expect(readFileSync(restored, "utf8").startsWith(content)).toBe(true);
	expect(loadEntriesFromFile(restored)).toContainEqual(
		expect.objectContaining({ message: expect.objectContaining({ content: "post-restore append" }) }),
	);
	expect(readSessionMetadata(f.db, restored)?.isArchived).toBe(false);
	expect(readSessionMetadata(f.db, `${f.file}.zst`)).toBeUndefined();
}

function appendAfterCrash(f: ReturnType<typeof fixture>) {
	const appended = `${JSON.stringify({ type: "message", id: "two", parentId: "one", timestamp: "2026-10-20T11:00:00Z", message: { role: "user", content: "appended after crash", timestamp: 2 } })}\n`;
	appendFileSync(f.file, appended);
	return f.content + appended;
}

describe("idle transcript archival crash recovery", () => {
	it.each(crashPoints)("finishes archival after %s and restores a writable transcript", async (point) => {
		const f = crashArchive(point);
		const result = await storage.archiveIdleSessionTranscripts(f.db, { agentDir: f.root, now });
		expect(result.errors).toEqual([]);
		expect(result.archivedPaths).toEqual(point === "after-unlink" ? [] : [`${f.file}.zst`]);
		expect(existsSync(f.file)).toBe(false);
		expect(zstdDecompressSync(readFileSync(`${f.file}.zst`))).toEqual(Buffer.from(f.content));
		expect(readSessionMetadata(f.db, f.file)).toBeUndefined();
		expect(readSessionMetadata(f.db, `${f.file}.zst`)).toMatchObject({ id: "old", isArchived: true });
		assertWritableRestore(f, `${f.file}.zst`);
	});
	for (const point of crashPoints) {
		it.each(["plain", "archive"])(`restores via %s immediately after ${point}`, (reference) => {
			const f = crashArchive(point);
			assertWritableRestore(f, reference === "plain" ? f.file : `${f.file}.zst`);
		});
	}
	for (const point of ["after-link", "before-unlink"] as const) {
		it(`keeps appended plain bytes on the next archive pass after ${point}`, async () => {
			const f = crashArchive(point);
			const content = appendAfterCrash(f);
			const result = await storage.archiveIdleSessionTranscripts(f.db, { agentDir: f.root, now });
			expect(result).toEqual({ archivedPaths: [], errors: [] });
			expect(readFileSync(f.file, "utf8")).toBe(content);
			expect(existsSync(`${f.file}.zst`)).toBe(false);
			expect(readSessionMetadata(f.db, `${f.file}.zst`)).toBeUndefined();
			expect(readSessionMetadata(f.db, f.file)).toMatchObject({ id: "old", isArchived: false });
			assertWritableRestore(f, f.file, content);
		});
		it.each(["plain", "archive"])(`restores appended bytes via %s after ${point}`, (reference) => {
			const f = crashArchive(point);
			const content = appendAfterCrash(f);
			assertWritableRestore(f, reference === "plain" ? f.file : `${f.file}.zst`, content);
		});
	}
});

describe("idle transcript archival", () => {
	it("compresses an old transcript byte-identically and relocates metadata for listing and resume", async () => {
		const f = fixture();
		const result = await storage.archiveIdleSessionTranscripts(f.db, { agentDir: f.root, now });
		expect(result.errors).toEqual([]);
		expect(result.archivedPaths).toEqual([`${f.file}.zst`]);
		expect(existsSync(f.file)).toBe(false);
		expect(zstdDecompressSync(readFileSync(`${f.file}.zst`))).toEqual(Buffer.from(f.content));
		expect(statSync(`${f.file}.zst`).mode & 0o777).toBe(0o600);
		expect(readSessionMetadata(f.db, f.file)).toBeUndefined();
		expect(readSessionMetadata(f.db, `${f.file}.zst`)?.isArchived).toBe(true);
		expect(await SessionManager.list(f.root, f.dir, undefined, f.db)).toEqual([]);
		expect(await SessionManager.listArchived(f.dir, undefined, f.db)).toEqual([
			expect.objectContaining({ id: "old", firstMessage: "needle cobalt café 🧭", path: `${f.file}.zst` }),
		]);
		const restored = restoreArchivedSession(f.db, `${f.file}.zst`);
		expect(SessionManager.open(restored).getSessionId()).toBe("old");
		expect(readFileSync(restored, "utf8")).toBe(f.content);
	});
	it("preserves source permissions under a restrictive process umask", async () => {
		const f = fixture();
		chmodSync(f.file, 0o640);
		const mask = process.umask(0o077);
		try {
			await storage.archiveIdleSessionTranscripts(f.db, { agentDir: f.root, now });
			expect(statSync(`${f.file}.zst`).mode & 0o777).toBe(0o640);
		} finally {
			process.umask(mask);
		}
	});
	it.each([0, 29, 30])("skips transcripts modified %i days ago", async (age) => {
		const f = fixture(age);
		await storage.archiveIdleSessionTranscripts(f.db, { agentDir: f.root, now });
		expect(readFileSync(f.file, "utf8")).toBe(f.content);
		expect(existsSync(`${f.file}.zst`)).toBe(false);
	});
	it("skips the starting runtime's transcript before DB ownership registration", async () => {
		const f = fixture();
		await storage.archiveIdleSessionTranscripts(f.db, { agentDir: f.root, now, currentSessionPath: f.file });
		expect(existsSync(f.file)).toBe(true);
	});
	it("skips a transcript held open through /proc even without a DB owner", async () => {
		const f = fixture();
		const fd = openSync(f.file, "r");
		try {
			await storage.archiveIdleSessionTranscripts(f.db, { agentDir: f.root, now });
		} finally {
			closeSync(fd);
		}
		expect(existsSync(f.file)).toBe(true);
	});
	it("skips a DB-owned session even with no open transcript descriptor", async () => {
		const f = fixture();
		registerRuntimeMailboxListener(f.db, { sessionId: "old", agentId: null }, process.pid, f.file);
		await storage.archiveIdleSessionTranscripts(f.db, { agentDir: f.root, now });
		expect(existsSync(f.file)).toBe(true);
	});
	it("skips a transcript held by another live process", async () => {
		const f = fixture();
		const child = spawn(
			process.execPath,
			[
				"-e",
				"require('node:fs').openSync(process.argv[1], 'r'); process.send('ready'); setInterval(() => {}, 1000)",
				f.file,
			],
			{ stdio: ["ignore", "ignore", "inherit", "ipc"] },
		);
		try {
			await once(child, "message");
			await storage.archiveIdleSessionTranscripts(f.db, { agentDir: f.root, now });
			expect(existsSync(f.file)).toBe(true);
		} finally {
			child.kill();
			await once(child, "exit");
		}
	});
	it("skips the separate transcript of an active DB agent", async () => {
		const f = fixture();
		bootstrapMultiAgentAgent(f.db, join(f.dir, "store.jsonl"), "child", {
			id: "child",
			displayName: "Child",
			lifecycle: "waiting_for_input",
			revision: 1,
			createdAt: new Date(now).toISOString(),
			updatedAt: new Date(now).toISOString(),
			cwd: f.root,
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: f.file, sessionId: "old" },
		});
		await storage.archiveIdleSessionTranscripts(f.db, { agentDir: f.root, now });
		expect(existsSync(f.file)).toBe(true);
	});
	it("does not overwrite an existing compressed archive", async () => {
		const f = fixture();
		writeFileSync(`${f.file}.zst`, "existing archive");
		await storage.archiveIdleSessionTranscripts(f.db, { agentDir: f.root, now });
		expect(readFileSync(f.file, "utf8")).toBe(f.content);
		expect(readFileSync(`${f.file}.zst`, "utf8")).toBe("existing archive");
	});
});
