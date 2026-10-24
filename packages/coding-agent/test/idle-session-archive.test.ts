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
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
	it.each(crashPoints)(
		"finishes archival after %s and restores a writable transcript",
		async (point) => {
			const f = crashArchive(point);
			// SIGKILL cannot release the pass claim; a new startup skips until its default stale window expires.
			expect(await storage.archiveIdleSessionTranscripts(f.db, { agentDir: f.root, now })).toEqual({
				archivedPaths: [],
				errors: [],
			});
			await delay(11_000);
			const result = await storage.archiveIdleSessionTranscripts(f.db, { agentDir: f.root, now });
			expect(result.errors).toEqual([]);
			expect(result.archivedPaths).toEqual(point === "after-unlink" ? [] : [`${f.file}.zst`]);
			expect(existsSync(f.file)).toBe(false);
			expect(zstdDecompressSync(readFileSync(`${f.file}.zst`))).toEqual(Buffer.from(f.content));
			expect(readSessionMetadata(f.db, f.file)).toBeUndefined();
			expect(readSessionMetadata(f.db, `${f.file}.zst`)).toMatchObject({ id: "old", isArchived: true });
			assertWritableRestore(f, `${f.file}.zst`);
		},
		20_000,
	);
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
			await delay(11_000);
			const result = await storage.archiveIdleSessionTranscripts(f.db, { agentDir: f.root, now });
			expect(result).toEqual({ archivedPaths: [], errors: [] });
			expect(readFileSync(f.file, "utf8")).toBe(content);
			expect(existsSync(`${f.file}.zst`)).toBe(false);
			expect(readSessionMetadata(f.db, `${f.file}.zst`)).toBeUndefined();
			expect(readSessionMetadata(f.db, f.file)).toMatchObject({ id: "old", isArchived: false });
			assertWritableRestore(f, f.file, content);
		}, 20_000);
		it.each(["plain", "archive"])(`restores appended bytes via %s after ${point}`, (reference) => {
			const f = crashArchive(point);
			const content = appendAfterCrash(f);
			assertWritableRestore(f, reference === "plain" ? f.file : `${f.file}.zst`, content);
		});
	}
});

interface ArchiveRaceReport {
	result: storage.IdleSessionArchiveResult;
	failure?: { code?: string; message: string };
	boundaries: { operation: string; code?: string; syscall?: string; message: string }[];
}

function startArchiveWorker(f: ReturnType<typeof fixture>, scenario: string, worker: string, agentDir = f.root) {
	const home = join(f.root, `home-${worker}`);
	const state = join(home, "state");
	mkdirSync(state, { recursive: true });
	const child = spawn(
		process.execPath,
		[
			"--import",
			import.meta.resolve("tsx"),
			new URL("./fixtures/idle-session-archive/race-worker.ts", import.meta.url).pathname,
			agentDir,
			f.file,
			f.db,
			scenario,
			worker,
			String(now),
		],
		{
			env: {
				...process.env,
				HOME: home,
				XDG_CONFIG_HOME: join(home, "config"),
				XDG_CACHE_HOME: join(home, "cache"),
				XDG_STATE_HOME: state,
				PI_CODING_AGENT_DIR: f.root,
				PI_CODING_AGENT_STATE_DIR: state,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		output += String(chunk);
	});
	child.on("error", (error) => {
		output += error.message;
	});
	const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
	const marker = (phase: string) => join(f.root, "gates", `${worker}-${phase}`);
	return {
		async wait(phase: string) {
			const until = Date.now() + 15_000;
			while (!existsSync(`${marker(phase)}.ready`) && !existsSync(marker("done.json"))) {
				if (child.exitCode !== null || child.signalCode !== null || Date.now() >= until) {
					throw new Error(`Worker ${worker} failed before ${phase}: ${output}`);
				}
				await delay(5);
			}
		},
		release(phase: string) {
			writeFileSync(`${marker(phase)}.release`, "");
		},
		async report(): Promise<ArchiveRaceReport> {
			const status = await exited;
			expect(status, output).toEqual({ code: 0, signal: null });
			return JSON.parse(readFileSync(marker("done.json"), "utf8"));
		},
		async dispose() {
			clearTimeout(deadline);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await exited;
		},
	};
}

// These are real filesystem races, not injected errors. Only child fs calls are paused.
describe.skipIf(process.platform !== "linux")("idle transcript archival concurrent passes", () => {
	it.each(["publish", "stale"])(
		"converges without errors after a %s race between real processes",
		async (scenario) => {
			const f = fixture();
			mkdirSync(join(f.root, "gates"));
			const workers: ReturnType<typeof startArchiveWorker>[] = [];
			try {
				const winner = startArchiveWorker(f, scenario, "winner");
				workers.push(winner);
				await winner.wait(scenario === "publish" ? "target-absent" : "candidate");
				const alias = join(f.root, "alias");
				symlinkSync(f.root, alias, "dir");
				const loser = startArchiveWorker(f, scenario, "loser", alias);
				workers.push(loser);
				// The losing process must finish while the winner remains paused inside its pass.
				const loserReport = await loser.report();
				expect(loserReport).toEqual({ result: { archivedPaths: [], errors: [] }, boundaries: [] });
				if (scenario === "publish") {
					winner.release("target-absent");
					await winner.wait("verified");
					winner.release("verified");
				} else {
					winner.release("candidate");
				}
				await winner.wait("publish");
				winner.release("publish");
				const winnerReport = await winner.report();
				const reports = { winner: winnerReport, loser: loserReport };
				console.info(`Archive race ${scenario}: ${JSON.stringify(reports)}`);
				expect.soft(readdirSync(f.dir)).toEqual(["old.jsonl.zst"]);
				expect.soft(zstdDecompressSync(readFileSync(`${f.file}.zst`))).toEqual(Buffer.from(f.content));
				expect.soft(readSessionMetadata(f.db, f.file)).toBeUndefined();
				expect.soft(readSessionMetadata(f.db, `${f.file}.zst`)).toMatchObject({ id: "old", isArchived: true });
				expect.soft(winnerReport.result.errors, JSON.stringify(reports)).toEqual([]);
				expect.soft(loserReport.result.errors, JSON.stringify(reports)).toEqual([]);
				const next = join(f.dir, "next.jsonl");
				const nextContent = f.content.replace('"id":"old"', '"id":"next"');
				writeFileSync(next, nextContent);
				utimesSync(next, new Date(now - 31 * day), new Date(now - 31 * day));
				expect(await storage.archiveIdleSessionTranscripts(f.db, { agentDir: f.root, now })).toEqual({
					archivedPaths: [`${next}.zst`],
					errors: [],
				});
				expect(zstdDecompressSync(readFileSync(`${next}.zst`))).toEqual(Buffer.from(nextContent));
				expect(readSessionMetadata(f.db, `${next}.zst`)).toMatchObject({ id: "next", isArchived: true });
			} finally {
				await Promise.all(workers.map((worker) => worker.dispose()));
			}
		},
		30_000,
	);
	it("reports a compromised claim without crashing or publishing after compression resumes", async () => {
		const f = fixture();
		mkdirSync(join(f.root, "gates"));
		const worker = startArchiveWorker(f, "compromised", "owner");
		try {
			await worker.wait("compressing");
			// Real filesystem interference, observed by the library's normal async heartbeat.
			rmSync(join(f.root, "sessions.lock"), { recursive: true });
			await delay(5_500);
			worker.release("compressing");
			const report = await worker.report();
			expect(report.failure).toMatchObject({ code: "ECOMPROMISED" });
			expect(readdirSync(f.dir)).toEqual(["old.jsonl"]);
			expect(readFileSync(f.file, "utf8")).toBe(f.content);
			expect(readSessionMetadata(f.db, f.file)).toMatchObject({ id: "old", isArchived: false });
			expect(await storage.archiveIdleSessionTranscripts(f.db, { agentDir: f.root, now })).toEqual({
				archivedPaths: [`${f.file}.zst`],
				errors: [],
			});
		} finally {
			await worker.dispose();
		}
	}, 20_000);
	it("still reports a genuine external source deletion", async () => {
		const f = fixture();
		mkdirSync(join(f.root, "gates"));
		const worker = startArchiveWorker(f, "external-delete", "owner");
		try {
			const report = await worker.report();
			expect(report.failure).toBeUndefined();
			expect(report.boundaries).toContainEqual(expect.objectContaining({ operation: "lstat", code: "ENOENT" }));
			expect(report.result.errors).toHaveLength(1);
			expect(report.result.errors[0]).toContain("ENOENT");
			expect(existsSync(`${f.file}.zst`)).toBe(false);
		} finally {
			await worker.dispose();
		}
	});
});

describe("idle transcript archival", () => {
	it("releases the claim after a pass-level database failure", async () => {
		const f = fixture();
		const invalidDb = join(f.root, "invalid.sqlite");
		writeFileSync(invalidDb, "not a database");
		await expect(storage.archiveIdleSessionTranscripts(invalidDb, { agentDir: f.root, now })).rejects.toThrow();
		expect(await storage.archiveIdleSessionTranscripts(f.db, { agentDir: f.root, now })).toEqual({
			archivedPaths: [`${f.file}.zst`],
			errors: [],
		});
	});
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
		const failed = await storage.archiveIdleSessionTranscripts(f.db, { agentDir: f.root, now });
		expect(failed.archivedPaths).toEqual([]);
		expect(failed.errors).toHaveLength(1);
		expect(failed.errors[0]).toContain(f.file);
		expect(readFileSync(f.file, "utf8")).toBe(f.content);
		expect(readFileSync(`${f.file}.zst`, "utf8")).toBe("existing archive");
		rmSync(`${f.file}.zst`);
		expect(await storage.archiveIdleSessionTranscripts(f.db, { agentDir: f.root, now })).toEqual({
			archivedPaths: [`${f.file}.zst`],
			errors: [],
		});
	});
});
