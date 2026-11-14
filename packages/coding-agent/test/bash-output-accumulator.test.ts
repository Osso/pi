import { readFileSync, rmSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";

let fullOutputPath: string | undefined;

afterEach(() => {
	if (fullOutputPath) rmSync(fullOutputPath, { force: true });
	fullOutputPath = undefined;
});

it.each([
	{ name: "one chunk", chunks: [`${"x".repeat(50000)}\n`] },
	{ name: "separate newline chunk", chunks: ["x".repeat(25000), "x".repeat(25000), "\n"] },
])("keeps the partial final line after trimming $name", async ({ chunks }) => {
	const updates: string[] = [];
	const bash = createBashTool(process.cwd(), {
		operations: {
			exec: async (_command, _cwd, { onData }) => {
				for (const chunk of chunks) onData(Buffer.from(chunk));
				return { exitCode: 0 };
			},
		},
	});

	const result = await bash.execute("long-line", { command: "injected-output" }, undefined, (update) => {
		for (const block of update.content) {
			if (block.type === "text") updates.push(block.text);
		}
	});
	fullOutputPath = result.details?.fullOutputPath;
	const output = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const expectedTail = "x".repeat(DEFAULT_MAX_BYTES);

	expect(output.split("\n\n")[0]).toBe(expectedTail);
	expect(output).toContain("[Showing last 10.0KB of line 1 (");
	expect(updates.at(-1)).toBe(expectedTail);
	expect(result.details?.truncation).toMatchObject({
		truncated: true,
		truncatedBy: "bytes",
		totalLines: 1,
		totalBytes: 50001,
		outputLines: 1,
		outputBytes: DEFAULT_MAX_BYTES,
		lastLinePartial: true,
	});
	expect(fullOutputPath).toBeDefined();
	if (!fullOutputPath) throw new Error("Full bash output was not persisted");
	expect(readFileSync(fullOutputPath, "utf-8")).toBe(chunks.join(""));
});

it("keeps complete trailing lines instead of the trimmed first line", async () => {
	const bash = createBashTool(process.cwd(), {
		operations: {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from(`${"x".repeat(50000)}\nlast line\n`));
				return { exitCode: 0 };
			},
		},
	});

	const result = await bash.execute("complete-tail", { command: "injected-output" });
	fullOutputPath = result.details?.fullOutputPath;
	const output = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

	expect(output).toBe(`last line\n\n\n[Showing lines 2-2 of 2 (10.0KB limit). Full output: ${fullOutputPath}]`);
	expect(result.details?.truncation).toMatchObject({ totalLines: 2, outputLines: 1, lastLinePartial: false });
});
