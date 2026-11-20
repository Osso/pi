import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const cliPath = join(import.meta.dirname, "../../../src/cli.ts");

it.each([
	{ label: "literal --offline value", args: ["--system-prompt", "--offline"], offline: false },
	{ label: "option after a literal -- value", args: ["--system-prompt", "--", "--offline"], offline: true },
	{ label: "text after the option separator", args: ["--", "--offline"], offline: false },
])("applies offline startup only for a parsed flag ($label)", ({ args, offline }) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-cli-offline-option-"));
	try {
		const statePath = join(dir, "offline.json");
		const preload = join(dir, "capture.mjs");
		writeFileSync(
			preload,
			`import { writeFileSync } from "node:fs";
process.on("exit", () => {
	writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({
		offline: process.env.PI_OFFLINE,
		skipVersionCheck: process.env.PI_SKIP_VERSION_CHECK,
	}));
});
`,
		);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PI_CODING_AGENT_DIR: join(dir, "agent"),
			PI_CODING_AGENT_STATE_DIR: join(dir, "state"),
		};
		delete env.PI_OFFLINE;
		delete env.PI_SKIP_VERSION_CHECK;
		const result = spawnSync(process.execPath, ["--import", preload, cliPath, "--version", ...args], {
			cwd: dir,
			encoding: "utf8",
			env,
			timeout: 20_000,
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
		expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual(
			offline ? { offline: "1", skipVersionCheck: "1" } : {},
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
