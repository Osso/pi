import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { type ShareGistHost, shareSessionAsGist } from "../src/modes/interactive/share-gist.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const originalPath = process.env.PATH;
let emptyBinDir: string | undefined;

afterEach(() => {
	process.env.PATH = originalPath;
	if (emptyBinDir) rmSync(emptyBinDir, { recursive: true, force: true });
	emptyBinDir = undefined;
});

describe("/share", () => {
	beforeAll(() => initTheme("dark"));

	it("says gh is not installed when gh is missing from PATH", async () => {
		emptyBinDir = mkdtempSync(join(tmpdir(), "pi-share-no-gh-"));
		process.env.PATH = emptyBinDir;
		const exportToHtml = vi.fn();
		const showError = vi.fn();
		const host = {
			session: { exportToHtml } as unknown as AgentSession,
			showError,
			showStatus: vi.fn(),
		} as unknown as ShareGistHost;

		await shareSessionAsGist(host);

		expect(showError).toHaveBeenCalledWith(
			"GitHub CLI (gh) is not installed. Install it from https://cli.github.com/",
		);
		expect(exportToHtml).not.toHaveBeenCalled();
	});

	it("uploads each session's own export when two shares overlap", async () => {
		emptyBinDir = mkdtempSync(join(tmpdir(), "pi-share-fake-gh-"));
		const uploads = join(emptyBinDir, "uploads.log");
		const gh = join(emptyBinDir, "gh");
		// The fake gh reads its file only after a delay, so the second export lands first.
		writeFileSync(
			gh,
			`#!/bin/sh\n[ "$1" = auth ] && exit 0\nsleep 0.3\ncat "$4" >> "${uploads}"\necho https://gist.github.com/u/id-$$\n`,
		);
		chmodSync(gh, 0o755);
		process.env.PATH = `${emptyBinDir}:${originalPath}`;
		const host = (html: string) =>
			({
				session: {
					exportToHtml: async (file: string) => writeFileSync(file, `${html}\n`),
				} as unknown as AgentSession,
				ui: { setFocus: () => {}, requestRender: () => {}, requestComponentRender: () => false },
				editor: new Container(),
				editorContainer: new Container(),
				showError: vi.fn(),
				showStatus: vi.fn(),
			}) as unknown as ShareGistHost;

		await Promise.all([shareSessionAsGist(host("<p>Session A</p>")), shareSessionAsGist(host("<p>Session B</p>"))]);

		expect(readFileSync(uploads, "utf8").split("\n").filter(Boolean).sort()).toEqual([
			"<p>Session A</p>",
			"<p>Session B</p>",
		]);
	});
});
