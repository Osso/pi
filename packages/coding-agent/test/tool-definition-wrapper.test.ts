import { existsSync, readFileSync } from "node:fs";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { defineTool } from "../src/core/extensions/types.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";

interface TextResult {
	content: Array<{ type: string; text?: string }>;
}

function textOutput(result: TextResult): string {
	return result.content
		.filter((content) => content.type === "text")
		.map((content) => content.text ?? "")
		.join("\n");
}

function requireFullOutputPath(details: unknown): string {
	const fullOutputPath = (details as { fullOutputPath?: string }).fullOutputPath;
	if (!fullOutputPath) {
		throw new Error("Expected full output path");
	}
	return fullOutputPath;
}

describe("wrapToolDefinition", () => {
	it("caps oversized tool text and preserves full output in a temp file", async () => {
		const hugeText = `start\n${"x".repeat(DEFAULT_MAX_BYTES * 2)}\nend`;
		const tool = wrapToolDefinition(
			defineTool({
				name: "huge_output",
				label: "Huge output",
				description: "Returns huge text",
				parameters: Type.Object({}),
				async execute() {
					return {
						content: [{ type: "text" as const, text: hugeText }],
						details: { ok: true },
					};
				},
			}),
		);

		const result = await tool.execute("test-call-huge-output", {}, undefined, undefined);
		const output = textOutput(result);
		const fullOutputPath = requireFullOutputPath(result.details);

		expect(output.length).toBeLessThan(DEFAULT_MAX_BYTES + 2048);
		expect(output).toContain("Full output:");
		expect(output).toContain("end");
		expect(output).not.toContain("start\n");
		expect(existsSync(fullOutputPath)).toBe(true);
		expect(readFileSync(fullOutputPath, "utf-8")).toBe(hugeText);
	});

	it("caps oversized partial update text and preserves full output in a temp file", async () => {
		const hugeText = `start\n${"y".repeat(DEFAULT_MAX_BYTES * 2)}\npartial-end`;
		const tool = wrapToolDefinition(
			defineTool({
				name: "huge_update",
				label: "Huge update",
				description: "Streams huge text",
				parameters: Type.Object({}),
				async execute(_toolCallId, _params, _signal, onUpdate) {
					onUpdate?.({
						content: [{ type: "text" as const, text: hugeText }],
						details: { ok: true },
					});
					return { content: [{ type: "text" as const, text: "done" }], details: { ok: true } };
				},
			}),
		);
		const updates: AgentToolResult<{ ok: boolean }>[] = [];

		await tool.execute("test-call-huge-update", {}, undefined, (update) => updates.push(update));
		const output = textOutput(updates[0]);
		const fullOutputPath = requireFullOutputPath(updates[0].details);

		expect(output.length).toBeLessThan(DEFAULT_MAX_BYTES + 2048);
		expect(output).toContain("Full output:");
		expect(output).toContain("partial-end");
		expect(output).not.toContain("start\n");
		expect(existsSync(fullOutputPath)).toBe(true);
		expect(readFileSync(fullOutputPath, "utf-8")).toBe(hugeText);
	});

	it("spills a single oversized chunk to a temp file", async () => {
		const hugeText = `start${"z".repeat(DEFAULT_MAX_BYTES * 2)}end`;
		const tool = wrapToolDefinition(
			defineTool({
				name: "single_huge_chunk",
				label: "Single huge chunk",
				description: "Returns one giant chunk",
				parameters: Type.Object({}),
				async execute() {
					return {
						content: [{ type: "text" as const, text: hugeText }],
						details: { ok: true },
					};
				},
			}),
		);

		const result = await tool.execute("test-call-single-huge-chunk", {}, undefined, undefined);
		const output = textOutput(result);
		const fullOutputPath = requireFullOutputPath(result.details);

		expect(output.length).toBeLessThan(DEFAULT_MAX_BYTES + 2048);
		expect(output).toContain("Full output:");
		expect(output).toContain("end");
		expect(existsSync(fullOutputPath)).toBe(true);
		expect(readFileSync(fullOutputPath, "utf-8")).toBe(hugeText);
	});
});
