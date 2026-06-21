import { describe, expect, it, vi } from "vitest";
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
			["rev-parse", "--verify", "origin/main"],
			["worktree", "add", "/repo/project-feature", "origin/main"],
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
			"origin/master",
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
});
