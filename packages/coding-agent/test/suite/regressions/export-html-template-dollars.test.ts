import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { exportFromFile } from "../../../src/core/export-html/index.ts";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "../../../src/core/session-manager.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";

const exportHtmlDir = join(import.meta.dirname, "../../../src/core/export-html");
let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

it("embeds the viewer and highlighter scripts verbatim, including $$ and $& sequences", async () => {
	initTheme("dark");
	tempDir = mkdtempSync(join(tmpdir(), "pi-export-dollars-"));
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "dollar-test",
		timestamp: new Date(0).toISOString(),
		cwd: tempDir,
	} satisfies SessionHeader;
	const sessionPath = join(tempDir, "session.jsonl");
	writeFileSync(sessionPath, `${JSON.stringify(header)}\n`);

	const html = readFileSync(await exportFromFile(sessionPath, join(tempDir, "out.html")), "utf8");

	const viewer = readFileSync(join(exportHtmlDir, "template.js"), "utf8");
	const highlighter = readFileSync(join(exportHtmlDir, "vendor", "highlight.min.js"), "utf8");
	expect(viewer).toContain("$${totalCost.toFixed(3)}");
	expect(highlighter).toContain("$&");
	// Boolean checks keep a failure from printing both multi-kilobyte scripts.
	expect(html.includes(viewer), "viewer script embedded verbatim").toBe(true);
	expect(html.includes(highlighter), "highlighter script embedded verbatim").toBe(true);
});
