import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getControlDbPath,
	listDescendantSessionPaths,
	listSubagentSessionPaths,
	readSessionMetadata,
	readSessionSandboxProfile,
	removeSessionMetadata,
	removeSessionsMetadata,
	writeSessionMetadata,
	writeSessionSandboxProfile,
} from "../src/core/session-control-db.ts";
import { createSqliteDatabase } from "../src/core/sqlite.ts";

describe("session control DB batch deletion", () => {
	let tempDir: string;
	let controlDbPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-session-db-batch-delete-"));
		controlDbPath = getControlDbPath(tempDir);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSession(sessionPath: string, parentSessionPath?: string, isSubagent = true): void {
		writeSessionMetadata(controlDbPath, {
			sessionPath,
			id: sessionPath,
			cwd: "/repo",
			parentSessionPath,
			isSubagent,
			createdAt: "2026-10-14T00:00:00.000Z",
			modifiedAt: "2026-10-14T00:00:00.000Z",
			messageCount: 1,
			firstMessage: sessionPath,
		});
	}

	it("traverses nested plain and archived parent aliases while preserving stored child paths", () => {
		writeSession("/root.jsonl", undefined, false);
		writeSession("/child.jsonl.zst", "/root.jsonl");
		writeSession("/sibling.jsonl", "/root.jsonl.zst");
		writeSession("/grandchild.jsonl", "/child.jsonl");
		writeSession("/great-grandchild.jsonl.zst", "/grandchild.jsonl.zst");
		writeSession("/other.jsonl", "/unrelated.jsonl");
		writeSession("/fork.jsonl", "/root.jsonl", false);
		writeSession("/fork-child.jsonl", "/fork.jsonl");

		const expected = [
			"/child.jsonl.zst",
			"/sibling.jsonl",
			"/grandchild.jsonl",
			"/great-grandchild.jsonl.zst",
		].sort();
		expect(listDescendantSessionPaths(controlDbPath, "/root.jsonl").sort()).toEqual(expected);
		expect(listDescendantSessionPaths(controlDbPath, "/root.jsonl.zst").sort()).toEqual(expected);
		expect(listSubagentSessionPaths(controlDbPath, "/root.jsonl").sort()).toEqual([
			"/child.jsonl.zst",
			"/sibling.jsonl",
		]);
		expect(readSessionMetadata(controlDbPath, "/other.jsonl")).toBeDefined();
	});

	it("deduplicates converging aliases and cycles without returning either root alias", () => {
		writeSession("/root.jsonl", "/leaf.jsonl");
		writeSession("/root.jsonl.zst", "/leaf.jsonl.zst");
		writeSession("/child.jsonl", "/root.jsonl");
		writeSession("/child.jsonl.zst", "/root.jsonl.zst");
		writeSession("/leaf.jsonl", "/child.jsonl.zst");

		expect(listDescendantSessionPaths(controlDbPath, "/root.jsonl.zst").sort()).toEqual([
			"/child.jsonl",
			"/child.jsonl.zst",
			"/leaf.jsonl",
		]);
	});

	it("returns no descendants for an absent parent", () => {
		expect(listDescendantSessionPaths(controlDbPath, "/missing.jsonl")).toEqual([]);
	});

	it("migrates missing legacy metadata columns before descendant lookup", () => {
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec(`CREATE TABLE session_metadata (
				session_path TEXT PRIMARY KEY, id TEXT NOT NULL, cwd TEXT NOT NULL, name TEXT,
				created_at TEXT NOT NULL, modified_at TEXT NOT NULL, message_count INTEGER NOT NULL,
				first_message TEXT NOT NULL, updated_at TEXT NOT NULL
			)`);
		} finally {
			db.close();
		}

		expect(listDescendantSessionPaths(controlDbPath, "/root.jsonl")).toEqual([]);
		writeSession("/child.jsonl.zst", "/root.jsonl");
		expect(listDescendantSessionPaths(controlDbPath, "/root.jsonl.zst")).toEqual(["/child.jsonl.zst"]);
	});

	it("removes only requested metadata and sandbox overrides, including single-session callers", () => {
		const paths = ["/child.jsonl.zst", "/sibling.jsonl", "/unrelated.jsonl"];
		for (const path of paths) {
			writeSession(path);
			writeSessionSandboxProfile(controlDbPath, path, path, "read-only");
		}

		removeSessionsMetadata(controlDbPath, [paths[0], paths[1], paths[0], "/absent.jsonl"]);
		for (const path of paths.slice(0, 2)) {
			expect(readSessionMetadata(controlDbPath, path)).toBeUndefined();
			expect(readSessionSandboxProfile(controlDbPath, path, path)).toBeUndefined();
		}
		expect(readSessionMetadata(controlDbPath, paths[2])?.firstMessage).toBe(paths[2]);
		expect(readSessionSandboxProfile(controlDbPath, paths[2], paths[2])).toBe("read-only");
		removeSessionsMetadata(controlDbPath, []);
		expect(readSessionMetadata(controlDbPath, paths[2])).toBeDefined();
		removeSessionMetadata(controlDbPath, paths[2]);
		expect(readSessionMetadata(controlDbPath, paths[2])).toBeUndefined();
		expect(readSessionSandboxProfile(controlDbPath, paths[2], paths[2])).toBeUndefined();
	});

	it("rolls back the entire batch and sandbox cleanup when a later deletion fails", () => {
		for (const path of ["/first.jsonl", "/blocked.jsonl"]) {
			writeSession(path);
			writeSessionSandboxProfile(controlDbPath, path, path, "read-only");
		}
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec(`CREATE TRIGGER block_session_deletion BEFORE DELETE ON session_metadata
				WHEN OLD.session_path = '/blocked.jsonl'
				BEGIN SELECT RAISE(ABORT, 'blocked deletion'); END`);
		} finally {
			db.close();
		}

		expect(() => removeSessionsMetadata(controlDbPath, ["/first.jsonl", "/blocked.jsonl"])).toThrow(
			"blocked deletion",
		);
		for (const path of ["/first.jsonl", "/blocked.jsonl"]) {
			expect(readSessionMetadata(controlDbPath, path)).toBeDefined();
			expect(readSessionSandboxProfile(controlDbPath, path, path)).toBe("read-only");
		}
	});
});
