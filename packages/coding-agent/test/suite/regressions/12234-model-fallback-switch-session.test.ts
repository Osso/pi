import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { getControlDbPath, readSessionMetadata, writeSessionModel } from "../../../src/core/session-control-db.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHeadlessPaths } from "../headless-pi.ts";

/** A saved session whose recorded model, gone/missing-model, no longer exists. */
function createSessionWithMissingModel(projectDir: string, sessionDir: string, controlDbPath: string): string {
	const sessionManager = SessionManager.create(projectDir, sessionDir);
	sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		api: "openai-completions",
		provider: "gone",
		model: "missing-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("session was not persisted");
	sessionManager.setMetadataControlDbPath(controlDbPath);
	writeSessionModel(controlDbPath, sessionFile, "gone", "missing-model");
	expect(readSessionMetadata(controlDbPath, sessionFile)).toMatchObject({
		modelProvider: "gone",
		modelId: "missing-model",
	});
	return sessionFile;
}

// Upstream #12234: "Could not restore model" was shown only at interactive startup. A /resume into a session
// whose model is gone fell back to another model silently, and the other modes never showed it.
describe("model fallback message", () => {
	it("is written to stderr in RPC mode when switch_session falls back to another model", async () => {
		const paths = createHeadlessPaths();
		try {
			const sessionFile = createSessionWithMissingModel(
				paths.workspaceDir,
				paths.sessionDir,
				getControlDbPath(paths.agentDir),
			);
			const cliPath = join(import.meta.dirname, "..", "..", "..", "src", "cli.ts");
			const preloadPath = join(import.meta.dirname, "..", "fixtures", "headless-pi-provider-preload.ts");
			const child = spawn(
				"node",
				[
					"--experimental-strip-types",
					"--import",
					pathToFileURL(preloadPath).href,
					cliPath,
					...["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-context-files"],
				],
				{
					cwd: paths.workspaceDir,
					env: {
						...process.env,
						PI_CODING_AGENT_DIR: paths.agentDir,
						PI_CODING_AGENT_STATE_DIR: paths.agentDir,
						PI_CODING_AGENT_SESSION_DIR: paths.sessionDir,
						PI_HEADLESS_PROVIDER_SOCKET: paths.socketPath,
					},
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			let stdout = "";
			let stderr = "";
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
			try {
				await new Promise<void>((resolve, reject) => {
					child.stdout.on("data", (chunk: Buffer) => {
						stdout += chunk.toString();
						if (stdout.includes('"command":"switch_session"')) resolve();
					});
					child.once("close", () => reject(new Error(`RPC process exited early. stderr:\n${stderr}`)));
					child.stdin.write(`${JSON.stringify({ id: "1", type: "switch_session", sessionPath: sessionFile })}\n`);
				});
				child.stdin.end();
				await closed;
			} finally {
				if (child.exitCode === null) child.kill("SIGKILL");
			}

			expect(stdout).toContain('"success":true');
			expect(stderr).toContain(
				"Warning: Could not restore model gone/missing-model. Using headless-faux/headless-faux-1",
			);
			expect(stdout).not.toContain("Could not restore model");
		} finally {
			rmSync(paths.tempDir, { recursive: true, force: true });
		}
	}, 60_000);
});
