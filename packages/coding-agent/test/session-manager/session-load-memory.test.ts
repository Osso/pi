import { spawnSync } from "node:child_process";
import {
	closeSync,
	createReadStream,
	createWriteStream,
	mkdtempSync,
	openSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdCompress } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const timestamp = "2026-10-20T00:00:00.000Z";
const HISTORY_ENTRIES = 32768;
const ENTRY_BYTES = 16384;
const MAX_OPEN_RSS_KIB = 256 * 1024;

function writeLargeTranscript(file: string): void {
	const fd = openSync(file, "wx");
	let parentId: string | null = null;
	const write = (entry: object) => writeSync(fd, `${JSON.stringify(entry)}\n`);
	try {
		write({ type: "session", version: 3, id: "memory-session", timestamp, cwd: "/tmp" });
		for (let index = 0; index < HISTORY_ENTRIES; index++) {
			const id = `old-${index}`;
			write({
				type: "message",
				id,
				parentId,
				timestamp,
				message: { role: "user", content: "x".repeat(ENTRY_BYTES), timestamp: 1 },
			});
			parentId = id;
		}
		write({
			type: "message",
			id: "retained",
			parentId,
			timestamp,
			message: { role: "user", content: "retained", timestamp: 2 },
		});
		write({
			type: "compaction",
			id: "compact",
			parentId: "retained",
			timestamp,
			summary: "summary",
			firstKeptEntryId: "retained",
			tokensBefore: 999,
		});
	} finally {
		closeSync(fd);
	}
}

describe("session open peak RSS", () => {
	let root: string;
	let plain: string;
	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), "pi-load-memory-"));
		plain = join(root, "large.jsonl");
		writeLargeTranscript(plain);
		await pipeline(createReadStream(plain), createZstdCompress(), createWriteStream(`${plain}.zst`));
	}, 60_000);
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it.each(["plain", "archived"])(
		"keeps a fresh %s open below 256 MiB for a 500+ MiB history",
		(storage) => {
			const file = storage === "archived" ? `${plain}.zst` : plain;
			const fixture = resolve(__dirname, "session-load-memory-fixture.ts");
			const loader = resolve(__dirname, "../../../../node_modules/tsx/dist/loader.mjs");
			const result = spawnSync(process.execPath, ["--import", loader, fixture, file], {
				encoding: "utf8",
				timeout: 90_000,
				env: {
					...process.env,
					HOME: join(root, "home"),
					PI_CODING_AGENT_DIR: join(root, "agent"),
					XDG_CONFIG_HOME: join(root, "config"),
					XDG_STATE_HOME: join(root, "state"),
					XDG_CACHE_HOME: join(root, "cache"),
					TSX_TSCONFIG_PATH: resolve(__dirname, "../../../../tsconfig.json"),
				},
			});
			expect(result.status, result.stderr).toBe(0);
			const measured = JSON.parse(result.stdout);
			console.log(JSON.stringify({ storage, fileBytes: statSync(plain).size, ...measured }));
			expect(statSync(plain).size).toBeGreaterThan(500 * 1024 * 1024);
			expect(measured.peakKiB).toBeLessThan(MAX_OPEN_RSS_KIB);
			expect(measured.loadedEntries).toBe(2);
		},
		100_000,
	);
});
