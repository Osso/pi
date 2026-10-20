import { spawn } from "node:child_process";
import { once } from "node:events";
import {
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
import { SessionManager } from "../src/core/session-manager.ts";

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
