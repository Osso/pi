import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { TUI } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";

// Upstream #12139: the note about a text-only model was saved in the result text and sent again after a model switch.
describe("read of an image with a text-only model", () => {
	let tempDir: string;

	beforeAll(() => {
		initTheme("dark");
		tempDir = mkdtempSync(join(tmpdir(), "pi-read-non-vision-"));
		writeFileSync(join(tempDir, "pixel.png"), Buffer.from(PNG_1X1, "base64"));
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("keeps the warning out of the model's text and shows it to the user", async () => {
		const definition = createReadToolDefinition(tempDir);
		const ctx = { model: { id: "text-only", input: ["text"] } } as unknown as Parameters<
			typeof definition.execute
		>[4];
		const result = await definition.execute("call", { path: "pixel.png" }, undefined, undefined, ctx);

		expect(result.content).toEqual([
			{ type: "text", text: "Read image file [image/png]" },
			expect.objectContaining({ type: "image", mimeType: "image/png" }),
		]);
		expect(result.details).toEqual({ imageUnsupportedByModel: "text-only" });

		const tool = new ToolExecutionComponent(
			"read",
			"call",
			{ path: "pixel.png" },
			{},
			definition,
			// SAFETY: ToolExecutionComponent only calls ui.requestRender(), which this stub implements.
			{ requestRender() {} } as TUI,
			tempDir,
		);
		tool.updateResult({ ...result, isError: false });
		expect(stripVTControlCharacters(tool.render(120).join("\n"))).toContain(
			"[text-only does not support images; it saw a placeholder instead]",
		);
	});
});
