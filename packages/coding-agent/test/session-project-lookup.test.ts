import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { getDefaultSessionDir } from "../src/core/session-manager.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-project-lookup-"));
	tempDirs.push(dir);
	return dir;
}

async function runCli(args: string[], cwd: string, agentDir: string): Promise<{ code: number | null; output: string }> {
	return new Promise((resolvePromise, reject) => {
		let output = "";
		const child = spawn(process.execPath, [cliPath, ...args], {
			cwd,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
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
		child.on("error", reject);
		child.on("close", (code) => resolvePromise({ code, output }));
		child.stdin.end("n\n");
	});
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("--session project lookup", () => {
	it("opens a globally located session whose stored cwd matches the current project", async () => {
		const tempRoot = createTempDir();
		const agentDir = join(tempRoot, "agent");
		const currentProject = join(tempRoot, "current-project");
		const storageProject = join(tempRoot, "storage-project");
		mkdirSync(currentProject, { recursive: true });
		mkdirSync(storageProject, { recursive: true });
		const sessionDir = getDefaultSessionDir(storageProject, agentDir);
		const sessionId = "019f9b6e-73e1-7676-877f-68b021d7de8d";
		writeFileSync(
			join(sessionDir, `2026-07-25T22-38-54-945Z_${sessionId}.jsonl`),
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: sessionId,
				timestamp: "2026-07-25T22:38:54.945Z",
				cwd: currentProject,
			})}\n`,
		);

		const result = await runCli(["-ne", "--session", sessionId, "--model", "missing-model", "-p", "hi"], currentProject, agentDir);

		expect(result.code).toBe(1);
		expect(result.output).toContain('Model "missing-model" not found');
		expect(result.output).not.toContain("Session found in different project");
		expect(result.output).not.toContain("Fork this session into current directory?");
	});
});
