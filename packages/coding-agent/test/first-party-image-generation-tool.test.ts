import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxLoaderPath = resolve(__dirname, "../../../node_modules/tsx/dist/loader.mjs");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("first-party image generation tool", () => {
	it("lists image_gen as an active default tool", () => {
		const homeDir = mkdtempSync(join(tmpdir(), "pi-image-gen-tool-"));
		tempDirs.push(homeDir);
		const agentDir = join(homeDir, ".pi", "agent");
		const result = spawnSync(process.execPath, ["--import", tsxLoaderPath, cliPath, "tools"], {
			cwd: homeDir,
			encoding: "utf8",
			env: {
				...process.env,
				HOME: homeDir,
				[ENV_AGENT_DIR]: agentDir,
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
		});

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toMatch(/^yes\s+image_gen\s+first-party/m);
	});
});
