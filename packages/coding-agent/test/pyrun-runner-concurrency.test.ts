import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PyrunRunnerClient } from "../extensions/pyrun/src/runner.ts";

// Like pyrun-jsonl: one request at a time; the stdin line after a pi_request is its reply.
const SEQUENTIAL_RUNNER = `import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
for (let next = await lines.next(); !next.done; next = await lines.next()) {
  const request = JSON.parse(next.value);
  if (typeof request.code !== "string") {
    process.stdout.write(JSON.stringify({ type: "error", error: "code must be a string" }) + "\\n");
    continue;
  }
  if (request.code === "bridge") {
    process.stdout.write(JSON.stringify({ type: "pi_request", method: "tools.call", params: {} }) + "\\n");
    const reply = JSON.parse((await lines.next()).value);
    process.stdout.write(JSON.stringify({ type: "completed", value: reply.result }) + "\\n");
  } else {
    process.stdout.write(JSON.stringify({ type: "completed", value: request.code }) + "\\n");
  }
}
`;

describe("PyrunRunnerClient concurrency", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-pyrun-concurrency-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("keeps a concurrent evaluation from being read as a pending bridge reply", async () => {
		const runnerPath = join(tempDir, "sequential-runner.mjs");
		writeFileSync(runnerPath, SEQUENTIAL_RUNNER);
		const runner = new PyrunRunnerClient({ args: [runnerPath], command: process.execPath, detached: false });
		const slowBridge = () => new Promise((resolve) => setTimeout(() => resolve("bridge-value"), 20));
		try {
			const results = await Promise.all([
				runner.evaluate({ code: "bridge" }, undefined, undefined, slowBridge),
				runner.evaluate({ code: "2+2" }),
			]);
			expect(results.map((result) => [result.type, result.value])).toEqual([
				["completed", "bridge-value"],
				["completed", "2+2"],
			]);
		} finally {
			runner.dispose();
		}
	});

	it("rejects the evaluation when the runner exits before reading a large request", async () => {
		const runnerPath = join(tempDir, "early-exit-runner.mjs");
		writeFileSync(runnerPath, "process.exit(3);\n");
		const runner = new PyrunRunnerClient({ args: [runnerPath], command: process.execPath, detached: false });
		const uncaught: unknown[] = [];
		const recordUncaught = (error: unknown) => uncaught.push(error);
		process.on("uncaughtException", recordUncaught);
		try {
			await expect(runner.evaluate({ code: "x".repeat(4 * 1024 * 1024) })).rejects.toThrow();
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(uncaught).toEqual([]);
		} finally {
			process.off("uncaughtException", recordUncaught);
			runner.dispose();
		}
	});
});
