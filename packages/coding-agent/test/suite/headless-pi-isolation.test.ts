import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { withHeadlessPi } from "./headless-pi.ts";

it.skipIf(process.platform === "win32")(
	"isolates headless prompts from host memory enrichment while preserving Pyrun",
	async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-headless-memory-isolation-"));
		const markerPath = join(tempDir, "enrich-invoked");
		const executablePath = join(tempDir, "claude-memory");
		writeFileSync(
			executablePath,
			`#!/bin/sh\nif [ "$1" = "enrich" ]; then printf invoked > ${JSON.stringify(markerPath)}; fi\n`,
		);
		chmodSync(executablePath, 0o755);
		try {
			await withHeadlessPi(
				async (agent) => {
					await agent.send({ type: "prompt", message: "Run isolated Pyrun" });
					const initialRequest = await agent.waitForLlmRequest();
					agent.respondToLlmRequest(
						initialRequest.id,
						fauxAssistantMessage(fauxToolCall("pyrun_eval", { code: 'print("isolated-pyrun")' }), {
							stopReason: "toolUse",
						}),
					);
					const completedRequest = await agent.waitForLlmRequest((request) => request.id !== initialRequest.id);
					const toolResults = completedRequest.messages.filter((message) => message.role === "toolResult");
					expect(toolResults).toHaveLength(1);
					expect(JSON.stringify(toolResults[0])).toContain("isolated-pyrun");
					expect(existsSync(markerPath)).toBe(false);
					agent.respondToLlmRequest(
						completedRequest.id,
						fauxAssistantMessage(
							[
								{ type: "text", text: "Isolated Pyrun complete" },
								fauxToolCall("end_turn", { reason: "Isolated Pyrun complete" }),
							],
							{ stopReason: "toolUse" },
						),
					);
					await agent.waitForEvent((event) => event.type === "agent_end");
				},
				{ env: { PI_CLAUDE_MEMORY: executablePath } },
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	},
);
