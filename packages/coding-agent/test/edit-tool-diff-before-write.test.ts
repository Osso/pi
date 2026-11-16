import { describe, expect, it, vi } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";

vi.mock("../src/core/tools/edit-diff.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/core/tools/edit-diff.ts")>();
	return {
		...original,
		generateDiffString: () => {
			throw new Error("diff failed");
		},
	};
});

describe("edit tool diff before write", () => {
	it("leaves the file unchanged when the diff fails", async () => {
		const writeFile = vi.fn(async () => {});
		const tool = createEditTool(process.cwd(), {
			operations: {
				access: async () => {},
				readFile: async () => Buffer.from("a\nb\n"),
				writeFile,
			},
		});

		await expect(
			tool.execute("test-diff-before-write", { path: "f.txt", edits: [{ oldText: "b", newText: "B" }] }),
		).rejects.toThrow("diff failed");
		expect(writeFile).not.toHaveBeenCalled();
	});
});
