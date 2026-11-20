import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type GitExec, resolveWorktree, WorktreeStartupError } from "../src/utils/git-worktree.ts";

function createGitExec(results: Array<{ stdout?: string; stderr?: string; reject?: Error }>) {
	const calls: Array<{ args: string[]; cwd: string }> = [];
	const exec: GitExec = async (args, options) => {
		calls.push({ args, cwd: options.cwd });
		const result = results.shift();
		if (!result) {
			throw new Error(`Unexpected git call: ${args.join(" ")}`);
		}
		if (result.reject) {
			throw result.reject;
		}
		return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	};
	return { calls, exec: vi.fn(exec) };
}

function gitFailure(message: string, stderr: string): Error {
	const error = new Error(message) as Error & { stderr: string };
	error.stderr = stderr;
	return error;
}

describe("resolveWorktree", () => {
	it("reuses an existing sibling worktree", async () => {
		const git = createGitExec([
			{ stdout: "/repo/project\n" },
			{ stdout: "worktree /repo/project\nHEAD abc\n\nworktree /repo/project-feature\nHEAD def\n" },
		]);

		await expect(resolveWorktree("feature", { cwd: "/repo/project", exec: git.exec })).resolves.toBe(
			"/repo/project-feature",
		);
		expect(git.calls.map((call) => call.args)).toEqual([
			["rev-parse", "--show-toplevel"],
			["worktree", "list", "--porcelain"],
		]);
	});

	it("reuses an existing worktree whose name ends in a space", async () => {
		const git = createGitExec([
			{ stdout: "/repo/project\n" },
			{ stdout: "worktree /repo/project\nHEAD abc\n\nworktree /repo/project-feature \nHEAD def\n" },
		]);

		await expect(resolveWorktree("feature ", { cwd: "/repo/project", exec: git.exec })).resolves.toBe(
			"/repo/project-feature ",
		);
		expect(git.calls).toHaveLength(2);
	});

	it("creates a new sibling worktree from origin/main", async () => {
		const git = createGitExec([
			{ stdout: "/repo/project\n" },
			{ stdout: "worktree /repo/project\nHEAD abc\n" },
			{ stdout: "origin/main\n" },
			{ stdout: "" },
		]);

		await expect(resolveWorktree("feature", { cwd: "/repo/project/subdir", exec: git.exec })).resolves.toBe(
			"/repo/project-feature",
		);
		expect(git.calls.map((call) => call.args)).toEqual([
			["rev-parse", "--show-toplevel"],
			["worktree", "list", "--porcelain"],
			["rev-parse", "--verify", "refs/remotes/origin/main"],
			["worktree", "add", "/repo/project-feature", "refs/remotes/origin/main"],
		]);
	});

	it("falls back to origin/master when origin/main is unavailable", async () => {
		const git = createGitExec([
			{ stdout: "/repo/project\n" },
			{ stdout: "worktree /repo/project\nHEAD abc\n" },
			{ reject: new Error("missing main") },
			{ stdout: "origin/master\n" },
			{ stdout: "" },
		]);

		await expect(resolveWorktree("feature", { cwd: "/repo/project", exec: git.exec })).resolves.toBe(
			"/repo/project-feature",
		);
		expect(git.calls.map((call) => call.args)).toContainEqual([
			"worktree",
			"add",
			"/repo/project-feature",
			"refs/remotes/origin/master",
		]);
	});

	it("throws a clear error when no supported remote base exists", async () => {
		const git = createGitExec([
			{ stdout: "/repo/project\n" },
			{ stdout: "worktree /repo/project\nHEAD abc\n" },
			{ reject: new Error("missing main") },
			{ reject: new Error("missing master") },
		]);

		await expect(resolveWorktree("feature", { cwd: "/repo/project", exec: git.exec })).rejects.toThrow(
			new WorktreeStartupError("No origin/main or origin/master ref found for worktree creation"),
		);
	});

	it("surfaces git stderr when the startup directory is not in a repository", async () => {
		const git = createGitExec([
			{ reject: gitFailure("Command failed: git rev-parse --show-toplevel", "fatal: not a git repository") },
		]);

		await expect(resolveWorktree("feature", { cwd: "/repo/project", exec: git.exec })).rejects.toThrow(
			"fatal: not a git repository",
		);
	});

	it("surfaces git stderr when worktree creation fails", async () => {
		const git = createGitExec([
			{ stdout: "/repo/project\n" },
			{ stdout: "worktree /repo/project\nHEAD abc\n" },
			{ stdout: "origin/main\n" },
			{
				reject: gitFailure(
					"Command failed: git worktree add /repo/project-feature origin/main",
					"fatal: 'feature' is already checked out",
				),
			},
		]);

		await expect(resolveWorktree("feature", { cwd: "/repo/project", exec: git.exec })).rejects.toThrow(
			"fatal: 'feature' is already checked out",
		);
	});
});

describe("resolveWorktree with real git", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function git(cwd: string, ...args: string[]): string {
		const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
		return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, env })
			.toString()
			.trim();
	}

	function createRepo(name: string): { repo: string; remoteCommit: string } {
		const root = mkdtempSync(join(tmpdir(), "pi-worktree-"));
		roots.push(root);
		const repo = join(root, name);
		mkdirSync(repo);
		git(repo, "init", "-q", "-b", "trunk");
		git(repo, "commit", "-q", "--allow-empty", "-m", "remote base");
		const remoteCommit = git(repo, "rev-parse", "HEAD");
		git(repo, "update-ref", "refs/remotes/origin/main", remoteCommit);
		return { repo, remoteCommit };
	}

	it("creates from the remote-tracking ref even when a local branch is named origin/main", async () => {
		const { repo, remoteCommit } = createRepo("project");
		git(repo, "commit", "-q", "--allow-empty", "-m", "local only");
		git(repo, "branch", "origin/main");

		const worktree = await resolveWorktree("feature", { cwd: repo });

		expect(git(worktree, "rev-parse", "HEAD")).toBe(remoteCommit);
	});

	it("does not reuse a registered worktree whose directory was deleted", async () => {
		const { repo } = createRepo("project");
		const worktree = await resolveWorktree("feature", { cwd: repo });
		rmSync(worktree, { recursive: true, force: true });

		await expect(resolveWorktree("feature", { cwd: repo })).rejects.toThrow(WorktreeStartupError);
		expect(existsSync(worktree)).toBe(false);
	});

	it("keeps trailing whitespace in the repository root", async () => {
		const { repo, remoteCommit } = createRepo("project ");

		const worktree = await resolveWorktree("feature", { cwd: repo });

		expect(worktree).toBe(`${repo}-feature`);
		expect(git(worktree, "rev-parse", "HEAD")).toBe(remoteCommit);
	});
});
