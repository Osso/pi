import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupDetachedJobArtifacts } from "../src/core/detached-job-cleanup.ts";
import { getControlDbPath } from "../src/core/session-control-db.ts";

const HOUR_MS = 60 * 60 * 1_000;
const ONE_GIB = 1024 ** 3;
const roots = new Set<string>();
const children = new Set<ChildProcess>();

afterEach(async () => {
	for (const child of children) {
		child.kill("SIGKILL");
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
	}
	children.clear();
	for (const root of roots) rmSync(root, { force: true, recursive: true });
	roots.clear();
});

function createRoot(): string {
	const root = join(tmpdir(), `pi-foreground-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
	roots.add(root);
	return root;
}

/** Lay out a job directory the way the Bash and Pyrun runners leave it after a foreground completion. */
function writeForegroundJob(
	jobsParent: string,
	jobId: string,
	options: { completedAt?: number; outputBytes?: number },
): string {
	const directory = join(jobsParent, "detached-jobs", "2026-11-01T00-00-00-000Z_session", jobId);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "launch.json"), "{}");
	writeFileSync(join(directory, "output.log"), "output");
	if (options.outputBytes !== undefined) truncateSync(join(directory, "output.log"), options.outputBytes);
	if (options.completedAt !== undefined) {
		const marker = join(directory, "foreground-completed");
		writeFileSync(marker, "completed\n");
		utimesSync(marker, options.completedAt / 1_000, options.completedAt / 1_000);
	}
	return directory;
}

describe("foreground job directory cleanup", () => {
	it("deletes foreground Bash and Pyrun job directories after 24 hours and keeps recent or running ones", () => {
		const root = createRoot();
		const now = Date.now();
		const sessionDirectory = join(root, "sessions", "--project--");
		const expiredBash = writeForegroundJob(root, "bash_1", { completedAt: now - 25 * HOUR_MS });
		const expiredPyrun = writeForegroundJob(sessionDirectory, "pyrun_1", { completedAt: now - 25 * HOUR_MS });
		const recentPyrun = writeForegroundJob(sessionDirectory, "pyrun_2", { completedAt: now - 2 * HOUR_MS });
		const running = writeForegroundJob(root, "bash_2", {});

		const result = cleanupDetachedJobArtifacts(getControlDbPath(root), { artifactRoot: root, now });

		expect(result.errors).toEqual([]);
		expect(result.deletedDirectories.sort()).toEqual([expiredBash, expiredPyrun].sort());
		expect(existsSync(expiredBash)).toBe(false);
		expect(existsSync(expiredPyrun)).toBe(false);
		expect(existsSync(recentPyrun)).toBe(true);
		expect(existsSync(running)).toBe(true);
	});

	it("keeps an expired foreground job directory that a live process still uses", async () => {
		const root = createRoot();
		const now = Date.now();
		const referenced = writeForegroundJob(root, "bash_live", { completedAt: now - 25 * HOUR_MS });
		const child = spawn("sleep", ["30"], { cwd: referenced, stdio: "ignore" });
		children.add(child);
		await new Promise<void>((resolve) => child.once("spawn", () => resolve()));

		const result = cleanupDetachedJobArtifacts(getControlDbPath(root), { artifactRoot: root, now });

		expect(result.deletedDirectories).toEqual([]);
		expect(existsSync(referenced)).toBe(true);
	});

	it("counts recent foreground job directories toward the two GiB cap, oldest first", () => {
		const root = createRoot();
		const now = Date.now();
		const oldest = writeForegroundJob(root, "bash_old", {
			completedAt: now - 3 * HOUR_MS,
			outputBytes: Math.ceil(1.1 * ONE_GIB),
		});
		const newest = writeForegroundJob(root, "bash_new", {
			completedAt: now - 2 * HOUR_MS,
			outputBytes: Math.ceil(1.1 * ONE_GIB),
		});

		const result = cleanupDetachedJobArtifacts(getControlDbPath(root), { artifactRoot: root, now });

		expect(result.deletedDirectories).toEqual([oldest]);
		expect(existsSync(newest)).toBe(true);
	});
});
