import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getControlDbPath,
	listSessionMetadata,
	retainControlDbConnection,
	writeSessionMetadata,
} from "../src/core/session-control-db.ts";
import { deleteSessionTree } from "../src/core/session-delete.ts";

describe("session tree deletion", () => {
	let dir: string;
	let controlDbPath: string;
	let releaseDb: () => void;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-delete-tree-"));
		controlDbPath = getControlDbPath(dir);
		releaseDb = retainControlDbConnection(controlDbPath);
		const bin = join(dir, "bin");
		mkdirSync(bin);
		const trash = join(bin, "trash");
		writeFileSync(
			trash,
			`#!${process.execPath}
const { unlinkSync } = require("node:fs");
const paths = process.argv.slice(2).filter(path => path !== "--");
if (paths.reduce((bytes, path) => bytes + Buffer.byteLength(path) + 9, 0) > 65536) {
  console.error("argument budget exceeded");
  process.exit(1);
}
setTimeout(() => {
  for (const path of paths) {
    if (process.env.TRASH_PARTIAL && (path.endsWith("blocked.jsonl") || path.endsWith("root.jsonl"))) continue;
    try { unlinkSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (process.env.TRASH_PARTIAL) { console.error("intentional partial trash failure"); process.exitCode = 1; }
}, Number(process.env.TRASH_DELAY || 0));
`,
		);
		chmodSync(trash, 0o755);
		vi.stubEnv("PATH", bin);
		vi.stubEnv("TRASH_DELAY", "0");
		vi.stubEnv("TRASH_PARTIAL", "");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		releaseDb();
		rmSync(dir, { recursive: true, force: true });
	});

	function session(name: string, parentSessionPath?: string, directory = false): string {
		const path = join(dir, name);
		if (directory) mkdirSync(path);
		else writeFileSync(path, "fixture\n");
		writeSessionMetadata(controlDbPath, {
			sessionPath: path,
			id: name,
			cwd: dir,
			parentSessionPath,
			isSubagent: parentSessionPath !== undefined,
			createdAt: "2026-10-14T00:00:00.000Z",
			modifiedAt: "2026-10-14T00:00:00.000Z",
			messageCount: 1,
			firstMessage: "disposable deletion fixture",
		});
		return path;
	}

	it("deletes nested archived descendants while preserving unrelated sessions", async () => {
		const root = session("root.jsonl.zst");
		const child = session("child.jsonl.zst", root.slice(0, -4));
		const leaf = session("leaf.jsonl", child.slice(0, -4));
		const unrelated = session("unrelated.jsonl");

		expect(await deleteSessionTree(root, controlDbPath)).toEqual({ ok: true, method: "trash" });
		for (const path of [root, child, leaf]) expect(existsSync(path)).toBe(false);
		expect(existsSync(unrelated)).toBe(true);
		expect(listSessionMetadata(controlDbPath).map((row) => row.sessionPath)).toEqual([unrelated]);
	});

	it("amortizes slow trash startup and keeps the event loop responsive", async () => {
		const root = session("root.jsonl");
		for (let index = 0; index < 12; index++) session(`child-${index}.jsonl`, root);
		vi.stubEnv("TRASH_DELAY", "80");
		let ticks = 0;
		const timer = setInterval(() => ticks++, 5);
		const started = performance.now();
		try {
			expect(await deleteSessionTree(root, controlDbPath)).toEqual({ ok: true, method: "trash" });
			expect(ticks).toBeGreaterThan(3);
			expect(performance.now() - started).toBeLessThan(800);
		} finally {
			clearInterval(timer);
		}
		expect(listSessionMetadata(controlDbPath)).toEqual([]);
	});

	it("trashes thousands of long paths within the executable argument budget", async () => {
		const root = session("root.jsonl");
		const unrelated = session("unrelated.jsonl");
		const children = Array.from({ length: 2200 }, (_, index) => session(`${index}-${"é".repeat(100)}.jsonl`, root));
		expect(await deleteSessionTree(root, controlDbPath)).toEqual({ ok: true, method: "trash" });
		for (const path of [root, ...children]) expect(existsSync(path)).toBe(false);
		expect(existsSync(unrelated)).toBe(true);
		expect(listSessionMetadata(controlDbPath).map((row) => row.sessionPath)).toEqual([unrelated]);
	}, 20_000);

	it("cleans up every file already trashed on partial failure but retains untouched metadata", async () => {
		const root = session("root.jsonl");
		const blocked = session("blocked.jsonl", root, true);
		const removed = session("removed.jsonl", root);
		const unrelated = session("unrelated.jsonl");
		vi.stubEnv("TRASH_PARTIAL", "1");

		const result = await deleteSessionTree(root, controlDbPath);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("blocked.jsonl");
			expect(result.error).toContain("intentional partial trash failure");
		}
		expect(existsSync(removed)).toBe(false);
		for (const path of [root, blocked, unrelated]) expect(existsSync(path)).toBe(true);
		expect(
			listSessionMetadata(controlDbPath)
				.map((row) => row.sessionPath)
				.sort(),
		).toEqual([root, blocked, unrelated].sort());
	});

	it("unlinks when trash cannot start and removes stale metadata for missing files", async () => {
		const root = session("root.jsonl");
		const missing = session("missing.jsonl", root);
		rmSync(missing);
		vi.stubEnv("PATH", join(dir, "missing-bin"));
		expect(await deleteSessionTree(root, controlDbPath)).toEqual({ ok: true, method: "unlink" });
		expect(existsSync(root)).toBe(false);
		expect(listSessionMetadata(controlDbPath)).toEqual([]);
	});

	it("deletes a standalone file without a control DB", async () => {
		const path = join(dir, "standalone.jsonl");
		writeFileSync(path, "fixture\n");
		expect(await deleteSessionTree(path, undefined)).toEqual({ ok: true, method: "trash" });
		expect(existsSync(path)).toBe(false);
	});
});
