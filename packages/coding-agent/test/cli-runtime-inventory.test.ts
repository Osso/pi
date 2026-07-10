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
	options?: {
		projectExtension?: boolean;
		globalSettings?: Record<string, unknown>;
		projectSettings?: Record<string, unknown>;
	},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	const tempRoot = createTempDir();
	const agentDir = join(tempRoot, "agent");
	const projectDir = join(tempRoot, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	if (options?.globalSettings) {
		await writeFile(join(agentDir, "settings.json"), JSON.stringify(options.globalSettings, null, 2), "utf8");
	}
	if (options?.projectSettings) {
		const projectConfigDir = join(projectDir, ".pi");
		mkdirSync(projectConfigDir, { recursive: true });
		await writeFile(
			join(projectConfigDir, "settings.json"),
			JSON.stringify(options.projectSettings, null, 2),
			"utf8",
		);
	}
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
		expect(result.stdout).toContain("approval-controls");
		expect(result.stdout).toContain("goal");
		expect(result.stdout).toContain("hostrun");
		expect(result.stdout).toContain("agents-core");
		expect(result.stdout).toContain("agent-viewer");
		expect(result.stdout).toContain("agents-mailbox");
		expect(result.stdout).toContain("run-plan");
		expect(result.stdout).toContain("safe");
	});

	it("skips first-party extensions disabled in settings", async () => {
		const result = await runCli(["extensions"], { globalSettings: { disabledExtensions: ["hostrun"] } });

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("approval-controls");
		expect(result.stdout).toContain("goal");
		expect(result.stdout).not.toContain("hostrun");
	});

	it("skips first-party extensions disabled by trusted project settings", async () => {
		const result = await runCli(["extensions", "--approve"], {
			projectSettings: { disabledExtensions: ["hostrun"] },
		});

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("approval-controls");
		expect(result.stdout).toContain("goal");
		expect(result.stdout).not.toContain("hostrun");
	});

	it("hides tools from first-party extensions disabled in settings", async () => {
		const result = await runCli(["tools"], { globalSettings: { disabledExtensions: ["hostrun"] } });

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).not.toContain("hostrun_eval");
		expect(result.stdout).toContain("manage_goal");
		expect(result.stdout).not.toContain("set_goal");
		expect(result.stdout).not.toContain("pause_goal");
		expect(result.stdout).not.toContain("goal_complete");
	});

	it("keeps first-party extensions after project trust reload", async () => {
		const result = await runCli(["extensions", "--approve"], { projectExtension: true });

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("approval-controls");
		expect(result.stdout).toContain("goal");
		expect(result.stdout).toContain("hostrun");
		expect(result.stdout).toContain("agents-core");
		expect(result.stdout).toContain("agent-viewer");
		expect(result.stdout).toContain("agents-mailbox");
		expect(result.stdout).toContain("run-plan");
		expect(result.stdout).toContain("safe");
		expect(result.stdout).toContain("project.ts");
	});

	it("keeps first-party extensions while resolving project trust", async () => {
		const result = await runCli(["extensions"], { projectExtension: true });

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("approval-controls");
		expect(result.stdout).toContain("goal");
		expect(result.stdout).toContain("hostrun");
		expect(result.stdout).toContain("agents-core");
		expect(result.stdout).toContain("agent-viewer");
		expect(result.stdout).toContain("agents-mailbox");
		expect(result.stdout).toContain("run-plan");
		expect(result.stdout).toContain("safe");
	});

	it("keeps first-party extensions when project extensions are untrusted", async () => {
		const result = await runCli(["extensions", "--no-approve"], { projectExtension: true });

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("approval-controls");
		expect(result.stdout).toContain("goal");
		expect(result.stdout).toContain("hostrun");
		expect(result.stdout).toContain("agents-core");
		expect(result.stdout).toContain("agent-viewer");
		expect(result.stdout).toContain("agents-mailbox");
		expect(result.stdout).toContain("run-plan");
		expect(result.stdout).toContain("safe");
		expect(result.stdout).not.toContain("project.ts");
	});

	it("shows first-party tools by default", async () => {
		const result = await runCli(["tools"]);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toMatch(/^yes\s+find\s+first-party\s+/m);
		expect(result.stdout).toMatch(/^yes\s+grep\s+first-party\s+/m);
		expect(result.stdout).toContain("hostrun_eval");
		expect(result.stdout).toMatch(/^yes\s+ls\s+first-party\s+/m);
		expect(result.stdout).toContain("manage_goal");
		expect(result.stdout).not.toContain("set_goal");
		expect(result.stdout).not.toContain("pause_goal");
		expect(result.stdout).not.toContain("goal_complete");
		expect(result.stdout).toContain("spawn_agent");
	});
});
