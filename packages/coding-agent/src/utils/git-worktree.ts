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
		throw new WorktreeStartupError(formatGitError(error));
	}
};

function outputText(output: string | Buffer): string {
	return typeof output === "string" ? output : output.toString("utf8");
}

function formatGitError(error: unknown): string {
	if (typeof error !== "object" || error === null) {
		return String(error);
	}

	const maybeOutput = error as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
	const stderr = maybeOutput.stderr === undefined ? "" : outputText(maybeOutput.stderr).trim();
	if (stderr.length > 0) {
		return stderr;
	}

	const stdout = maybeOutput.stdout === undefined ? "" : outputText(maybeOutput.stdout).trim();
	if (stdout.length > 0) {
		return stdout;
	}

	return maybeOutput.message ?? String(error);
}

async function gitOutput(exec: GitExec, args: string[], cwd: string): Promise<string> {
	try {
		const result = await exec(args, { cwd });
		// Strip only the line terminator: paths such as the repository root may end in whitespace.
		return outputText(result.stdout).replace(/\r?\n$/, "");
	} catch (error) {
		if (error instanceof WorktreeStartupError) {
			throw error;
		}
		throw new WorktreeStartupError(formatGitError(error));
	}
}

/** Paths of registered worktrees whose directory still exists; Git marks deleted ones `prunable`. */
function parseWorktreePaths(output: string): string[] {
	return output
		.split(/\r?\n\r?\n/)
		.map((record) => record.split(/\r?\n/))
		.filter((lines) => !lines.some((line) => line.startsWith("prunable")))
		.map((lines) => lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length) ?? "") // Paths may end in whitespace; never trim them.
		.filter((path) => path.length > 0);
}

// Full ref names: a local branch named `origin/main` must not shadow the remote-tracking ref.
async function resolveBaseRef(exec: GitExec, repoRoot: string): Promise<string> {
	for (const ref of ["refs/remotes/origin/main", "refs/remotes/origin/master"]) {
		try {
			await gitOutput(exec, ["rev-parse", "--verify", ref], repoRoot);
			return ref;
		} catch {}
	}

	throw new WorktreeStartupError("No origin/main or origin/master ref found for worktree creation");
}

export async function resolveWorktree(name: string, options: { cwd: string; exec?: GitExec }): Promise<string> {
	// The name becomes one sibling directory suffix; an empty name or a path separator breaks that.
	if (name.length === 0 || name.includes("/")) {
		throw new WorktreeStartupError(`Invalid worktree name ${JSON.stringify(name)}: use a non-empty name without "/"`);
	}
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
