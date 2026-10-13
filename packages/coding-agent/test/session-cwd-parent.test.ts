import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findNearestExistingCwd, getMissingSessionCwdIssue } from "../src/core/session-cwd.ts";

describe("nearest existing cwd", () => {
	let directory: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-cwd-parent-"));
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("returns an existing directory unchanged", () => {
		expect(findNearestExistingCwd(directory)).toBe(directory);
	});

	it("returns the nearest surviving directory after nested cwd deletion", () => {
		const surviving = join(directory, "surviving");
		const removed = join(surviving, "removed");
		const cwd = join(removed, "nested");
		mkdirSync(cwd, { recursive: true });
		rmSync(removed, { recursive: true });
		expect(findNearestExistingCwd(cwd)).toBe(surviving);
	});

	it("walks past an existing file candidate", () => {
		const file = join(directory, "file");
		writeFileSync(file, "not a directory");
		expect(findNearestExistingCwd(file)).toBe(directory);
	});

	it("walks past ENOTDIR when a candidate ancestor is a file", () => {
		const file = join(directory, "file");
		writeFileSync(file, "not a directory");
		expect(findNearestExistingCwd(join(file, "nested", "cwd"))).toBe(directory);
	});

	it("accepts a symlink to an existing directory", () => {
		const link = join(directory, "link");
		symlinkSync(directory, link);
		expect(findNearestExistingCwd(link)).toBe(link);
	});

	it("walks past a broken symlink", () => {
		const link = join(directory, "link");
		symlinkSync(join(directory, "missing"), link);
		expect(findNearestExistingCwd(link)).toBe(directory);
	});

	it("propagates symlink loop errors instead of recovering", () => {
		const link = join(directory, "loop");
		symlinkSync(link, link);
		expect(() => findNearestExistingCwd(link)).toThrow(expect.objectContaining({ code: "ELOOP" }));
	});

	it("propagates permission errors instead of recovering", () => {
		const restricted = join(directory, "restricted");
		const cwd = join(restricted, "cwd");
		mkdirSync(cwd, { recursive: true });
		chmodSync(restricted, 0);
		try {
			expect(() => findNearestExistingCwd(cwd)).toThrow(expect.objectContaining({ code: "EACCES" }));
		} finally {
			chmodSync(restricted, 0o700);
		}
	});

	it("returns the filesystem root unchanged", () => {
		expect(findNearestExistingCwd("/")).toBe("/");
	});

	it("uses a directory instead of an existing file as fallback cwd", () => {
		const file = join(directory, "file");
		writeFileSync(file, "not a directory");
		const issue = getMissingSessionCwdIssue(
			{ getCwd: () => join(directory, "missing"), getSessionFile: () => join(directory, "session.jsonl") },
			file,
		);
		expect(issue?.fallbackCwd).toBe(directory);
	});
});
