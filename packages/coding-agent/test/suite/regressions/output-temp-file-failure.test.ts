import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../../../src/core/bash-executor.ts";
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import { createBashTool } from "../../../src/core/tools/bash.ts";

// A full or unwritable $TMPDIR made the spill stream emit an unhandled "error" that crashed pi
// (port of upstream 943a99e3c, #10585). The open fails asynchronously, while the command still runs.
function spillingOperations(): BashOperations {
	return {
		exec: async (_command, _cwd, { onData }) => {
			for (let line = 0; line < 3000; line++) onData(Buffer.from(`line ${line}\n`));
			await new Promise((resolve) => setTimeout(resolve, 50));
			onData(Buffer.from("last line\n"));
			return { exitCode: 0 };
		},
	};
}

afterEach(() => {
	vi.unstubAllEnvs();
});

it("returns the truncated tail when the bash tool cannot create its full output file", async () => {
	vi.stubEnv("TMPDIR", join("/nonexistent", "pi-missing-tmp"));
	const bash = createBashTool(process.cwd(), { operations: spillingOperations() });

	const result = await bash.execute("spill", { command: "injected-output" });
	const text = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

	expect(text).toContain("last line");
	expect(text).toMatch(/\[Showing lines \d+-3001 of 3001 \(10\.0KB limit\)\. Could not save the full output: ENOENT/);
	expect(text).not.toContain("Full output:");
	expect(result.details?.fullOutputPath).toBeUndefined();
});

it("returns the truncated tail when a ! command cannot create its full output file", async () => {
	vi.stubEnv("TMPDIR", join("/nonexistent", "pi-missing-tmp"));

	const result = await executeBashWithOperations("injected-output", process.cwd(), spillingOperations());

	expect(result.truncated).toBe(true);
	expect(result.output).toContain("last line");
	expect(result.fullOutputPath).toBeUndefined();
});
