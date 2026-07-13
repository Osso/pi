import { existsSync, readFileSync } from "node:fs";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { defineTool, type ExtensionContext } from "../src/core/extensions/types.ts";
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
	it("passes the agent lifecycle start timestamp into extension context", async () => {
		let observedStartedAt: number | undefined;
		const tool = wrapToolDefinition(
			defineTool({
				name: "execution_timing",
				label: "Execution timing",
				description: "Reads execution timing",
				parameters: Type.Object({}),
				async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
					observedStartedAt = ctx.toolExecutionStartedAt;
					return { content: [{ type: "text" as const, text: "done" }], details: {} };
				},
			}),
			() => ({}) as ExtensionContext,
		);

		await tool.execute("timed-call", {}, undefined, undefined, { startedAt: 1_234 });

		expect(observedStartedAt).toBe(1_234);
	});

	it("preserves lazy extension context property descriptors", async () => {
		let cwdReads = 0;
		const observedCwds: string[] = [];
		const baseContext = {} as ExtensionContext;
		Object.defineProperty(baseContext, "cwd", {
			configurable: true,
			enumerable: true,
			get: () => `cwd-${++cwdReads}`,
		});
		const tool = wrapToolDefinition(
			defineTool({
				name: "lazy_context",
				label: "Lazy context",
				description: "Reads a guarded context getter",
				parameters: Type.Object({}),
				async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
					observedCwds.push(ctx.cwd, ctx.cwd);
					return { content: [{ type: "text" as const, text: "done" }], details: {} };
				},
			}),
			() => baseContext,
		);

		await tool.execute("lazy-call", {}, undefined, undefined, { startedAt: 1_234 });

		expect(observedCwds).toEqual(["cwd-1", "cwd-2"]);
	});

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

	it("reuses one spill file across oversized partial updates", async () => {
		const firstText = `first\n${"a".repeat(DEFAULT_MAX_BYTES * 2)}\nfirst-end`;
		const secondText = `second\n${"b".repeat(DEFAULT_MAX_BYTES * 2)}\nsecond-end`;
		const tool = wrapToolDefinition(
			defineTool({
				name: "repeated_huge_updates",
				label: "Repeated huge updates",
				description: "Streams repeated huge text",
				parameters: Type.Object({}),
				async execute(_toolCallId, _params, _signal, onUpdate) {
					onUpdate?.({ content: [{ type: "text" as const, text: firstText }], details: { ok: true } });
					onUpdate?.({ content: [{ type: "text" as const, text: secondText }], details: { ok: true } });
					return { content: [{ type: "text" as const, text: "done" }], details: { ok: true } };
				},
			}),
		);
		const updates: AgentToolResult<{ ok: boolean }>[] = [];

		await tool.execute("test-call-repeated-huge-updates", {}, undefined, (update) => updates.push(update));
		const firstPath = requireFullOutputPath(updates[0].details);
		const secondPath = requireFullOutputPath(updates[1].details);

		expect(secondPath).toBe(firstPath);
		expect(readFileSync(secondPath, "utf-8")).toBe(secondText);
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
