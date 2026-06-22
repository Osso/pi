import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-runtime-inventory-"));
	tempDirs.push(dir);
	return dir;
}

async function runCli(
	args: string[],
	options?: { projectExtension?: boolean },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	const tempRoot = createTempDir();
	const agentDir = join(tempRoot, "agent");
	const projectDir = join(tempRoot, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	if (options?.projectExtension) {
		const projectExtensionsDir = join(projectDir, ".pi", "extensions");
		mkdirSync(projectExtensionsDir, { recursive: true });
		await writeFile(join(projectExtensionsDir, "project.ts"), "export default function() {}\n", "utf8");
	}

	return await new Promise((resolvePromise, reject) => {
		const child = spawn(
			process.execPath,
			[resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs"), cliPath, ...args],
			{
				cwd: projectDir,
				env: {
					...process.env,
					[ENV_AGENT_DIR]: agentDir,
					PI_OFFLINE: "1",
					TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolvePromise({ stdout, stderr, code });
		});
	});
}

describe("runtime inventory CLI", () => {
	it("loads first-party extensions by default", async () => {
		const result = await runCli(["extensions"]);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("goal");
		expect(result.stdout).toContain("multi-agent");
		expect(result.stdout).toContain("run-plan");
	});

	it("keeps first-party extensions after project trust reload", async () => {
		const result = await runCli(["extensions", "--approve"], { projectExtension: true });

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("goal");
		expect(result.stdout).toContain("multi-agent");
		expect(result.stdout).toContain("run-plan");
		expect(result.stdout).toContain("project.ts");
	});

	it("keeps first-party extensions while resolving project trust", async () => {
		const result = await runCli(["extensions"], { projectExtension: true });

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("goal");
		expect(result.stdout).toContain("multi-agent");
		expect(result.stdout).toContain("run-plan");
	});

	it("keeps first-party extensions when project extensions are untrusted", async () => {
		const result = await runCli(["extensions", "--no-approve"], { projectExtension: true });

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("goal");
		expect(result.stdout).toContain("multi-agent");
		expect(result.stdout).toContain("run-plan");
		expect(result.stdout).not.toContain("project.ts");
	});

	it("shows first-party tools by default", async () => {
		const result = await runCli(["tools"]);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("goal_complete");
		expect(result.stdout).toContain("spawn_agent");
	});
});
