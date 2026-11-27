import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ENV_AGENT_DIR, ENV_STATE_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("pi config without a terminal exits with an error instead of drawing the selector into a pipe", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-config-no-tty-")));
	tempDirs.push(root);
	let stdout = "";
	let stderr = "";
	const child = spawn(process.execPath, [cliPath, "config"], {
		cwd: root,
		env: {
			...process.env,
			[ENV_AGENT_DIR]: join(root, "agent"),
			[ENV_STATE_DIR]: join(root, "state"),
			PI_OFFLINE: "1",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
	const code = await new Promise<number | null>((resolveExit, reject) => {
		child.on("error", reject);
		child.on("close", resolveExit);
	});
	clearTimeout(timer);

	expect(code).toBe(1);
	expect(stdout).toBe("");
	expect(stderr).toContain("pi config requires an interactive terminal");
}, 30_000);
