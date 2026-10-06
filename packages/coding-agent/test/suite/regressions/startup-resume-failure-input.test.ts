import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { getControlDbPath, readRuntimeMailboxListener } from "../../../src/core/session-control-db.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { withHeadlessPi } from "../headless-pi.ts";

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill("SIGTERM");
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			exited,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, 2_000);
			}),
		]);
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await exited;
		}
	} finally {
		clearTimeout(timer);
	}
}

async function waitForOutput(
	child: ChildProcessWithoutNullStreams,
	readOutput: () => string,
	text: string,
): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (readOutput().includes(text)) return;
		if (child.exitCode !== null || child.signalCode !== null) break;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Interactive Pi did not render '${text}':\n${readOutput()}`);
}

describe("interactive startup resumed continuation failure", () => {
	it.each([
		{
			failure: "missing authentication",
			abortThinking: false,
			expectedError: "No API key found for headless-faux.",
		},
		{
			failure: "aborted model thinking",
			abortThinking: true,
			expectedError: "Main session thinking phase exceeded 15 minutes",
		},
	])(
		"accepts extension commands and another request after $failure",
		async ({ abortThinking, expectedError }) => {
			await withHeadlessPi(async (agent) => {
				// Restore a real post-tool transcript and fail its startup continuation.
				const session = SessionManager.create(agent.paths.workspaceDir, agent.paths.sessionDir);
				session.appendMessage({ role: "user", content: "Interrupted request", timestamp: Date.now() });
				session.appendMessage(
					fauxAssistantMessage(fauxToolCall("read", { path: "seed.txt" }, { id: "seed-read" }), {
						stopReason: "toolUse",
					}),
				);
				session.appendMessage({
					role: "toolResult",
					toolCallId: "seed-read",
					toolName: "read",
					content: [{ type: "text", text: "Seed result" }],
					isError: false,
					timestamp: Date.now(),
				});
				const sessionFile = session.getSessionFile();
				if (!sessionFile) throw new Error("Missing interrupted session file");
				const sessionId = session.getSessionId();
				const controlDbPath = getControlDbPath(agent.paths.agentDir);
				const originalEntries = session.getEntries();

				const modelsPath = join(agent.paths.agentDir, "models.json");
				const models = JSON.parse(readFileSync(modelsPath, "utf8")) as {
					providers: Record<string, { apiKey?: string }>;
				};
				if (!abortThinking) delete models.providers["headless-faux"].apiKey;
				writeFileSync(modelsPath, JSON.stringify(models));
				const timeoutPreloadPath = join(agent.paths.tempDir, "shorten-first-thinking-phase.mjs");
				writeFileSync(
					timeoutPreloadPath,
					`const startTimer = globalThis.setTimeout;
const thinkingPhaseMs = 15 * 60 * 1000;
const firstThinkingPhaseMs = 200;
let shortened = false;
globalThis.setTimeout = (callback, delay, ...args) => {
	if (!shortened && delay === thinkingPhaseMs) {
		shortened = true;
		delay = firstThinkingPhaseMs;
	}
	return startTimer(callback, delay, ...args);
};
`,
				);
				const restoreAuthPath = join(agent.paths.tempDir, "restore-auth.ts");
				writeFileSync(
					restoreAuthPath,
					`import { getApiProvider } from "@earendil-works/pi-ai/compat";
export default function (pi) {
	const provider = getApiProvider("headless-faux");
	if (!provider) throw new Error("Missing preloaded faux provider");
	pi.registerProvider("headless-faux", { api: "headless-faux", streamSimple: provider.streamSimple });
	pi.registerCommand("restore-test-auth", {
		handler: async (_args, ctx) => {
			ctx.modelRegistry.authStorage.setRuntimeApiKey("headless-faux", "test-key");
			ctx.ui.notify("Test authentication restored", "info");
		},
	});
}
`,
				);
				const child = spawn(
					process.execPath,
					[
						"--experimental-strip-types",
						"--import",
						pathToFileURL(join(import.meta.dirname, "../fixtures/headless-pi-provider-preload.ts")).href,
						"--import",
						pathToFileURL(join(import.meta.dirname, "../fixtures/headless-pi-tty-preload.mjs")).href,
						...(abortThinking ? ["--import", pathToFileURL(timeoutPreloadPath).href] : []),
						join(import.meta.dirname, "../../../src/cli.ts"),
						"--approve",
						"--no-context-files",
						"--no-skills",
						"--no-themes",
						"--provider",
						"headless-faux",
						"--model",
						"headless-faux-1",
						"--session",
						sessionFile,
						"--name",
						"Startup failure regression",
						"-e",
						restoreAuthPath,
					],
					{
						cwd: agent.paths.workspaceDir,
						env: {
							...process.env,
							PI_OFFLINE: "1",
							NO_COLOR: "1",
							TERM: "xterm-256color",
							PI_CODING_AGENT_DIR: agent.paths.agentDir,
							PI_CODING_AGENT_SESSION_DIR: agent.paths.sessionDir,
							PI_CODING_AGENT_STATE_DIR: agent.paths.agentDir,
							PI_HEADLESS_PROVIDER_SOCKET: join(agent.paths.tempDir, "provider.sock"),
						},
					},
				);
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (chunk: Buffer) => {
					stdout += chunk.toString();
				});
				child.stderr.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
				const readOutput = () => `${stdout}\n${stderr}`;
				try {
					if (abortThinking) {
						await agent.waitForLlmRequest(
							(candidate) =>
								candidate.sessionId === sessionId && candidate.userMessages.includes("Interrupted request"),
						);
					}
					await waitForOutput(child, readOutput, expectedError);
					child.stdin.write("/session-id\r");
					await waitForOutput(child, readOutput, `Session ID: ${sessionId}`);
					// The error must be surfaced by the interactive UI, not the outer CLI catch.
					expect(stdout).toContain(expectedError);
					child.stdin.write("/restore-test-auth\r");
					await waitForOutput(child, readOutput, "Test authentication restored");
					child.stdin.write("Normal request after startup failure\r");
					const request = await agent
						.waitForLlmRequest(
							(candidate) => candidate.userMessages.includes("Normal request after startup failure"),
							5_000,
						)
						.catch((error: unknown) => {
							throw new Error(`${String(error)}\n${stripVTControlCharacters(readOutput()).slice(-5_000)}`);
						});
					expect(request.sessionId).toBe(sessionId);
					agent.respondToLlmRequest(
						request.id,
						fauxAssistantMessage(
							[
								{ type: "text", text: "Recovered normal response" },
								fauxToolCall("end_turn", { reason: "Request complete" }),
							],
							{ stopReason: "toolUse" },
						),
					);
					await waitForOutput(child, readOutput, "Recovered normal response");
					const completed = SessionManager.open(sessionFile);
					if (abortThinking) {
						expect(completed.buildSessionContext().messages).toContainEqual(
							expect.objectContaining({ role: "assistant", stopReason: "aborted" }),
						);
					}
					expect(completed.getSessionId()).toBe(sessionId);
					expect(completed.getEntries().slice(0, originalEntries.length)).toEqual(originalEntries);
					expect(completed.buildSessionContext().messages).toContainEqual(
						expect.objectContaining({
							role: "assistant",
							content: expect.arrayContaining([{ type: "text", text: "Recovered normal response" }]),
						}),
					);
					expect(readRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId })).toMatchObject({
						pid: child.pid,
						sessionPath: sessionFile,
					});
					expect(child.exitCode, readOutput()).toBeNull();
				} finally {
					await stopProcess(child);
				}
			});
		},
		60_000,
	);
});
