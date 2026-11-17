import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { findApprovalPreset } from "../../../src/core/permissions/presets.ts";
import { RpcClient } from "../../../src/modes/rpc/rpc-client.ts";
import { createHeadlessPaths, createProviderServer, runWithCleanup } from "../headless-pi.ts";

describe("RpcClient waits for an automatic retry (#6363)", () => {
	it("promptAndWait returns the retried turn, not the failed attempt", async () => {
		const paths = createHeadlessPaths();
		const cacheDir = join(paths.tempDir, "compile-cache");
		mkdirSync(cacheDir);
		writeFileSync(
			join(paths.agentDir, "settings.json"),
			JSON.stringify({
				approvalPolicy: findApprovalPreset("auto-approve").policy,
				approvalPreset: "auto-approve",
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 },
			}),
		);
		let requests = 0;
		let provider: Awaited<ReturnType<typeof createProviderServer>> | undefined;
		let client: RpcClient | undefined;
		await runWithCleanup(
			async () => {
				provider = await createProviderServer(paths.socketPath, (request) => {
					requests += 1;
					const message =
						requests === 1
							? fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 Service Unavailable" })
							: fauxAssistantMessage(
									[
										{ type: "text", text: "Recovered after retry." },
										fauxToolCall("end_turn", { reason: "done" }),
									],
									{ stopReason: "toolUse" },
								);
					provider
						?.getSocket()
						?.write(`${JSON.stringify({ type: "response", requestId: request.id, message })}\n`);
				});
				const preloadPath = join(import.meta.dirname, "..", "fixtures", "headless-pi-provider-preload.ts");
				client = new RpcClient({
					executablePath: "node",
					cliPath: join(import.meta.dirname, "..", "..", "..", "src", "cli.ts"),
					cwd: paths.workspaceDir,
					env: {
						NODE_COMPILE_CACHE: cacheDir,
						PI_CODING_AGENT_DIR: paths.agentDir,
						PI_CODING_AGENT_STATE_DIR: paths.agentDir,
						PI_CODING_AGENT_SESSION_DIR: paths.sessionDir,
						PI_HEADLESS_PROVIDER_SOCKET: paths.socketPath,
					},
					provider: "headless-faux",
					model: "headless-faux-1",
					nodeArgs: ["--experimental-strip-types", "--import", pathToFileURL(preloadPath).href],
					args: [
						"--approve",
						"--no-session",
						"--no-context-files",
						"--no-skills",
						"--no-themes",
						"--no-extensions",
					],
				});
				await client.start();

				const events = await client.promptAndWait("hi", undefined, 30_000);

				const finalTexts = events.flatMap((event) =>
					event.type === "message_end" && event.message.role === "assistant"
						? event.message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
						: [],
				);
				expect(requests).toBe(2);
				expect(finalTexts).toContain("Recovered after retry.");
				expect(events.at(-1)?.type).toBe("agent_settled");
			},
			async () => {
				await client?.stop();
				provider?.getSocket()?.destroy();
				if (provider) await new Promise((resolve) => provider?.server.close(resolve));
				rmSync(paths.tempDir, { recursive: true, force: true });
			},
		);
	}, 60_000);
});
