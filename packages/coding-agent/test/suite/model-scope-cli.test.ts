import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHeadlessPaths } from "./headless-pi.ts";

function runCustomModels(args: string[], disabledModels?: string[]) {
	const paths = createHeadlessPaths();
	try {
		writeFileSync(
			join(paths.agentDir, "models.json"),
			JSON.stringify({
				providers: {
					hunt: {
						baseUrl: "https://example.invalid/v1",
						api: "openai-completions",
						models: [{ id: "hunt-base" }, { id: "hunt-legacy" }],
						disabledModels,
					},
				},
			}),
		);
		return spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				join(import.meta.dirname, "..", "..", "src", "cli.ts"),
				"--offline",
				"--no-session",
				"--no-supervisor",
				"--no-context-files",
				"--no-skills",
				"--no-themes",
				"--no-extensions",
				...args,
			],
			{
				cwd: paths.workspaceDir,
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: paths.agentDir,
					PI_CODING_AGENT_STATE_DIR: paths.tempDir,
				},
				encoding: "utf8",
				timeout: 15_000,
			},
		);
	} finally {
		rmSync(paths.tempDir, { recursive: true, force: true });
	}
}

function listCustomModels(selection: string[], apiKey?: string) {
	return runCustomModels([...selection, ...(apiKey ? ["--api-key", apiKey] : []), "--list-models", "hunt"]);
}

describe("CLI model scope authentication", () => {
	it.each([
		["--models", "hunt-base"],
		["--models", "hunt/hunt-base:high"],
		["--models", "hunt*"],
		["--model", "hunt-base"],
	])("authenticates a first-time custom model selected with %s %s", (flag, pattern) => {
		const result = listCustomModels([flag, pattern], "fixture-key");

		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).not.toContain("No models match pattern");
		expect(result.stderr).not.toContain("--api-key requires a model");
		expect(result.stdout).toMatch(/hunt\s+hunt-base/);
	});

	it("keeps unauthenticated models unavailable without a supplied key", () => {
		const result = listCustomModels(["--models", "hunt-base"]);

		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toContain('No models match pattern "hunt-base"');
		expect(result.stdout).not.toContain("hunt-base");
	});
});

describe("CLI disabled models", () => {
	it("lists the authenticated provider's unmatched model only", () => {
		const result = runCustomModels(
			["--model", "hunt/hunt-base", "--api-key", "fixture-key", "--list-models", "hunt"],
			["hunt-leg*"],
		);

		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toMatch(/hunt\s+hunt-base/);
		expect(result.stdout).not.toContain("hunt-legacy");
		expect(result.stderr).not.toContain("errors loading models.json");
	});

	it("rejects an explicit request for the disabled model", () => {
		const result = runCustomModels(["--print", "--model", "hunt/hunt-legacy"], ["hunt-leg*"]);

		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(1);
		expect(result.stderr).toContain('Model "hunt/hunt-legacy" not found.');
		expect(result.stderr).not.toContain("Using custom model id");
	});
});
