import { execFile } from "node:child_process";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class WorktreeStartupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorktreeStartupError";
	}
}

export type GitExec = (
	args: string[],
	options: { cwd: string },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

const defaultGitExec: GitExec = async (args, options) => {
	try {
		const result = await execFileAsync("git", args, { cwd: options.cwd });
		return { stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		if (error instanceof Error) {
			throw new WorktreeStartupError(error.message);
		}
		throw new WorktreeStartupError(String(error));
	}
};

function outputText(output: string | Buffer): string {
	return typeof output === "string" ? output : output.toString("utf8");
}

async function gitOutput(exec: GitExec, args: string[], cwd: string): Promise<string> {
	const result = await exec(args, { cwd });
	return outputText(result.stdout).trim();
}

function parseWorktreePaths(output: string): string[] {
	return output
		.split(/\r?\n/)
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length).trim())
		.filter((line) => line.length > 0);
}

async function resolveBaseRef(exec: GitExec, repoRoot: string): Promise<"origin/main" | "origin/master"> {
	try {
		await gitOutput(exec, ["rev-parse", "--verify", "origin/main"], repoRoot);
		return "origin/main";
	} catch {}

	try {
		await gitOutput(exec, ["rev-parse", "--verify", "origin/master"], repoRoot);
		return "origin/master";
	} catch {}

	throw new WorktreeStartupError("No origin/main or origin/master ref found for worktree creation");
}

export async function resolveWorktree(name: string, options: { cwd: string; exec?: GitExec }): Promise<string> {
	const exec = options.exec ?? defaultGitExec;
	let repoRoot: string;
	try {
		repoRoot = await gitOutput(exec, ["rev-parse", "--show-toplevel"], options.cwd);
	} catch (error) {
		if (error instanceof WorktreeStartupError) {
			throw new WorktreeStartupError(`Unable to find git repository: ${error.message}`);
		}
		throw new WorktreeStartupError(`Unable to find git repository: ${String(error)}`);
	}

	const targetPath = `${dirname(repoRoot)}/${basename(repoRoot)}-${name}`;
	const worktreeList = await gitOutput(exec, ["worktree", "list", "--porcelain"], repoRoot);
	if (parseWorktreePaths(worktreeList).includes(targetPath)) {
		return targetPath;
	}

	const baseRef = await resolveBaseRef(exec, repoRoot);
	try {
		await gitOutput(exec, ["worktree", "add", targetPath, baseRef], repoRoot);
	} catch (error) {
		if (error instanceof WorktreeStartupError) {
			throw error;
		}
		throw new WorktreeStartupError(String(error));
	}
	return targetPath;
}
