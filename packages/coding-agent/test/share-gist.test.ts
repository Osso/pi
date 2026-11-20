import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { type ShareGistHost, shareSessionAsGist } from "../src/modes/interactive/share-gist.ts";

const originalPath = process.env.PATH;
let emptyBinDir: string | undefined;

afterEach(() => {
	process.env.PATH = originalPath;
	if (emptyBinDir) rmSync(emptyBinDir, { recursive: true, force: true });
	emptyBinDir = undefined;
});

describe("/share", () => {
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
});
