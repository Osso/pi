import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, ENV_STATE_DIR } from "../src/config.ts";
import { getControlDbPath, writeSessionMetadata } from "../src/core/session-control-db.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-project-lookup-"));
	tempDirs.push(dir);
	return dir;
}

function runGit(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

type CliResult = { code: number | null; output: string; timedOut: boolean };

function buildSessionLookupCliArgs(sessionId: string): string[] {
	return [
		"-ne",
		"-ns",
		"-np",
		"--no-themes",
		"-nc",
		"-nt",
		"--session",
		sessionId,
		"--model",
		"missing-model",
		"-p",
		"hi",
	];
}

async function runCli(args: string[], cwd: string, agentDir: string, input: string): Promise<CliResult> {
	return new Promise((resolvePromise, reject) => {
		let output = "";
		let timedOut = false;
		const child = spawn(process.execPath, [cliPath, ...args], {
			cwd,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				[ENV_STATE_DIR]: agentDir,
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdout.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			output += chunk.toString();
		});
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, 5000);
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			resolvePromise({ code, output, timedOut });
		});
		child.stdin.end(input);
	});
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("--session project lookup", () => {
	it("opens an indexed session from another worktree in the same Git repository", async () => {
		const tempRoot = createTempDir();
		const agentDir = join(tempRoot, "agent");
		const currentProject = join(tempRoot, "current-project");
		const storedWorktree = join(tempRoot, "stored-worktree");
		const indexedSessionDir = join(tempRoot, "indexed-sessions");
		mkdirSync(currentProject, { recursive: true });
		mkdirSync(indexedSessionDir, { recursive: true });
		runGit(currentProject, "init", "--initial-branch=master");
		runGit(currentProject, "config", "user.email", "test@example.com");
		runGit(currentProject, "config", "user.name", "Test User");
		runGit(currentProject, "commit", "--allow-empty", "-m", "initial");
		runGit(currentProject, "worktree", "add", "-b", "stored-session", storedWorktree);
		const sessionId = "019f9b6e-73e1-7676-877f-68b021d7de8d";
		const sessionPath = join(indexedSessionDir, `2026-07-25T22-38-54-945Z_${sessionId}.jsonl`);
		writeFileSync(
			sessionPath,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: sessionId,
				timestamp: "2026-07-25T22:38:54.945Z",
				cwd: currentProject,
			})}\n`,
		);
		writeSessionMetadata(getControlDbPath(agentDir), {
			sessionPath,
			id: sessionId,
			cwd: storedWorktree,
			createdAt: "2026-07-25T22:38:54.945Z",
			modifiedAt: "2026-07-25T22:38:54.945Z",
			messageCount: 0,
			firstMessage: "",
			allMessagesText: "",
		});

		const result = await runCli(
			buildSessionLookupCliArgs(sessionId),
			currentProject,
			agentDir,
			"n\n",
		);

		expect(result.timedOut).toBe(false);
		expect(result.code).toBe(1);
		expect(result.output).toContain('Model "missing-model" not found');
		expect(result.output).not.toContain("Session found in different project");
		expect(result.output).not.toContain("Fork this session into current directory?");
	});

	it("accepts fork confirmation for a different Git project without hanging", async () => {
		const tempRoot = createTempDir();
		const agentDir = join(tempRoot, "agent");
		const currentProject = join(tempRoot, "current-project");
		const foreignProject = join(tempRoot, "foreign-project");
		const indexedSessionDir = join(tempRoot, "indexed-sessions");
		for (const project of [currentProject, foreignProject]) {
			mkdirSync(project, { recursive: true });
			runGit(project, "init", "--initial-branch=master");
		}
		mkdirSync(indexedSessionDir, { recursive: true });
		const sessionId = "019f9b6e-73e1-7676-877f-68b021d7de8e";
		const sessionPath = join(indexedSessionDir, `2026-07-25T22-38-54-945Z_${sessionId}.jsonl`);
		writeFileSync(
			sessionPath,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: sessionId,
				timestamp: "2026-07-25T22:38:54.945Z",
				cwd: foreignProject,
			})}\n`,
		);
		writeSessionMetadata(getControlDbPath(agentDir), {
			sessionPath,
			id: sessionId,
			cwd: foreignProject,
			createdAt: "2026-07-25T22:38:54.945Z",
			modifiedAt: "2026-07-25T22:38:54.945Z",
			messageCount: 0,
			firstMessage: "",
			allMessagesText: "",
		});

		const result = await runCli(
			buildSessionLookupCliArgs(sessionId),
			currentProject,
			agentDir,
			"y\n",
		);

		expect(result.timedOut).toBe(false);
		expect(result.code).toBe(1);
		expect(result.output).toContain(`Session found in different project: ${foreignProject}`);
		expect(result.output).toContain("Fork this session into current directory? [y/N]");
		expect(result.output).toContain('Model "missing-model" not found');
	});
});
