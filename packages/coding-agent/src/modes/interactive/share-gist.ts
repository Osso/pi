import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Container, EditorComponent, TUI } from "@earendil-works/pi-tui";
import { getShareViewerUrl } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { BorderedLoader } from "./components/bordered-loader.ts";
import { theme } from "./theme/theme.ts";

export interface ShareGistHost {
	readonly session: AgentSession;
	readonly ui: TUI;
	readonly editor: EditorComponent;
	readonly editorContainer: Container;
	showStatus(message: string): void;
	showError(message: string): void;
}

/** Export a session and create the secret gist used by `/share` and RPC clients. */
export async function createSessionGist(
	session: AgentSession,
	signal?: AbortSignal,
): Promise<{ url: string; gistUrl: string }> {
	const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
	if (authResult.error) throw new Error("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
	if (authResult.status !== 0) throw new Error("GitHub CLI is not logged in. Run 'gh auth login' first.");
	if (signal?.aborted) throw new Error("Share cancelled");

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-share-"));
	const tmpFile = path.join(tmpDir, "session.html");
	try {
		await session.exportToHtml(tmpFile);
		if (signal?.aborted) throw new Error("Share cancelled");
		const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
			const proc = spawn("gh", ["gist", "create", "--public=false", tmpFile]);
			let stdout = "";
			let stderr = "";
			proc.stdout?.on("data", (data) => {
				stdout += data.toString();
			});
			proc.stderr?.on("data", (data) => {
				stderr += data.toString();
			});
			const abort = () => proc.kill();
			signal?.addEventListener("abort", abort, { once: true });
			proc.on("error", (error) => reject(error));
			proc.on("close", (code) => {
				signal?.removeEventListener("abort", abort);
				resolve({ stdout, stderr, code });
			});
		});
		if (signal?.aborted) throw new Error("Share cancelled");
		if (result.code !== 0) throw new Error(result.stderr.trim() || "Unknown error");
		const gistUrl = result.stdout.trim();
		const gistId = gistUrl.split("/").pop();
		if (!gistId) throw new Error("Failed to parse gist ID from gh output");
		return { url: getShareViewerUrl(gistId), gistUrl };
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

/** `/share`: create a secret gist and show its viewer URL. */
export async function shareSessionAsGist(host: ShareGistHost): Promise<void> {
	const loader = new BorderedLoader(host.ui, theme, "Creating gist...");
	host.editorContainer.clear();
	host.editorContainer.addChild(loader);
	host.ui.setFocus(loader);
	host.ui.requestRender();

	let restored = false;
	const restoreEditor = () => {
		if (restored) return;
		restored = true;
		loader.dispose();
		host.editorContainer.clear();
		host.editorContainer.addChild(host.editor);
		host.ui.setFocus(host.editor);
	};
	loader.onAbort = () => {
		restoreEditor();
		host.showStatus("Share cancelled");
	};

	try {
		const result = await createSessionGist(host.session, loader.signal);
		restoreEditor();
		host.showStatus(`Share URL: ${result.url}\nGist: ${result.gistUrl}`);
	} catch (error: unknown) {
		if (loader.signal.aborted) return;
		restoreEditor();
		host.showError(`Failed to create gist: ${error instanceof Error ? error.message : String(error)}`);
	}
}
