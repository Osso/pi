import { describe, expect, it, vi } from "vitest";
import {
	type CodeIndexOperations,
	createAllToolDefinitions,
	createOutlineToolDefinition,
	createReadOnlyToolDefinitions,
	createReferencesToolDefinition,
	createSymbolToolDefinition,
	DEFAULT_ACTIVE_TOOL_NAMES,
} from "../src/core/tools/index.ts";

function textOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

describe("code-index backed tools", () => {
	it("registers outline, symbol, and references as default read-only built-in tools", () => {
		expect(DEFAULT_ACTIVE_TOOL_NAMES).toEqual(expect.arrayContaining(["outline", "symbol", "references"]));
		expect(createReadOnlyToolDefinitions(process.cwd()).map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["outline", "symbol", "references"]),
		);
		expect(Object.keys(createAllToolDefinitions(process.cwd()))).toEqual(
			expect.arrayContaining(["outline", "symbol", "references"]),
		);
	});

	it("runs outline through code-index with optional flags", async () => {
		const operations: CodeIndexOperations = {
			run: vi.fn(async () => ({ stdout: "outline output\n", stderr: "", exitCode: 0 })),
		};
		const tool = createOutlineToolDefinition("/repo", { operations });

		const result = await tool.execute(
			"call-1",
			{ path: "src", digest: true, glob: "**/*.ts", show: "createTool" },
			undefined,
			undefined,
			{} as Parameters<typeof tool.execute>[4],
		);

		expect(operations.run).toHaveBeenCalledWith(
			["outline", "src", "--digest", "--glob", "**/*.ts", "--show", "createTool"],
			"/repo",
			undefined,
		);
		expect(textOutput(result)).toBe("outline output");
	});

	it("runs symbol through code-index with kind and file filters", async () => {
		const operations: CodeIndexOperations = {
			run: vi.fn(async () => ({ stdout: "[]\n", stderr: "", exitCode: 0 })),
		};
		const tool = createSymbolToolDefinition("/repo", { operations });

		await tool.execute(
			"call-1",
			{ name: "createTool", kind: "function", file: "src/core/tools" },
			undefined,
			undefined,
			{} as Parameters<typeof tool.execute>[4],
		);

		expect(operations.run).toHaveBeenCalledWith(
			["symbol", "createTool", "--kind", "function", "--file", "src/core/tools"],
			"/repo",
			undefined,
		);
	});

	it("runs references through code-index with a kind filter", async () => {
		const operations: CodeIndexOperations = {
			run: vi.fn(async () => ({ stdout: "[]\n", stderr: "", exitCode: 0 })),
		};
		const tool = createReferencesToolDefinition("/repo", { operations });

		await tool.execute(
			"call-1",
			{ name: "createTool", kind: "call" },
			undefined,
			undefined,
			{} as Parameters<typeof tool.execute>[4],
		);

		expect(operations.run).toHaveBeenCalledWith(["references", "createTool", "--kind", "call"], "/repo", undefined);
	});

	it("reports code-index stderr on failures", async () => {
		const operations: CodeIndexOperations = {
			run: vi.fn(async () => ({ stdout: "", stderr: "index unavailable", exitCode: 1 })),
		};
		const tool = createSymbolToolDefinition("/repo", { operations });

		await expect(
			tool.execute("call-1", { name: "missing" }, undefined, undefined, {} as Parameters<typeof tool.execute>[4]),
		).rejects.toThrow("index unavailable");
	});
});
