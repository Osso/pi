import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Container, EditorComponent, TUI } from "@earendil-works/pi-tui";
import { getShareViewerUrl } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { BorderedLoader } from "./components/bordered-loader.ts";
import { theme } from "./theme/theme.ts";

/** The interactive-mode state that /share reads and updates. */
export interface ShareGistHost {
	readonly session: AgentSession;
	readonly ui: TUI;
	readonly editor: EditorComponent;
	readonly editorContainer: Container;
	showStatus(message: string): void;
	showError(message: string): void;
}

/** /share: export the session to HTML, upload it as a secret gist with gh, and show the viewer URL. */
export async function shareSessionAsGist(host: ShareGistHost): Promise<void> {
	// spawnSync reports a missing gh through `error` (ENOENT); it does not throw.
	const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
	if (authResult.error) {
		host.showError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
		return;
	}
	if (authResult.status !== 0) {
		host.showError("GitHub CLI is not logged in. Run 'gh auth login' first.");
		return;
	}

	// Export to a private temp directory: a shared fixed path lets concurrent /share runs upload each other's export.
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-share-"));
	const tmpFile = path.join(tmpDir, "session.html");
	try {
		await host.session.exportToHtml(tmpFile);
	} catch (error: unknown) {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		host.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		return;
	}

	// Show cancellable loader, replacing the editor
	const loader = new BorderedLoader(host.ui, theme, "Creating gist...");
	host.editorContainer.clear();
	host.editorContainer.addChild(loader);
	host.ui.setFocus(loader);
	host.ui.requestRender();

	const restoreEditor = () => {
		loader.dispose();
		host.editorContainer.clear();
		host.editorContainer.addChild(host.editor);
		host.ui.setFocus(host.editor);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	};

	// Create a secret gist asynchronously
	let proc: ReturnType<typeof spawn> | null = null;

	loader.onAbort = () => {
		proc?.kill();
		restoreEditor();
		host.showStatus("Share cancelled");
	};

	try {
		const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
			proc = spawn("gh", ["gist", "create", "--public=false", tmpFile]);
			let stdout = "";
			let stderr = "";
			proc.stdout?.on("data", (data) => {
				stdout += data.toString();
			});
			proc.stderr?.on("data", (data) => {
				stderr += data.toString();
			});
			proc.on("close", (code) => resolve({ stdout, stderr, code }));
		});

		if (loader.signal.aborted) return;

		restoreEditor();

		if (result.code !== 0) {
			const errorMsg = result.stderr?.trim() || "Unknown error";
			host.showError(`Failed to create gist: ${errorMsg}`);
			return;
		}

		// Extract gist ID from the URL returned by gh
		// gh returns something like: https://gist.github.com/username/GIST_ID
		const gistUrl = result.stdout?.trim();
		const gistId = gistUrl?.split("/").pop();
		if (!gistId) {
			host.showError("Failed to parse gist ID from gh output");
			return;
		}

		// Create the preview URL
		const previewUrl = getShareViewerUrl(gistId);
		host.showStatus(`Share URL: ${previewUrl}\nGist: ${gistUrl}`);
	} catch (error: unknown) {
		if (!loader.signal.aborted) {
			restoreEditor();
			host.showError(`Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}
}
