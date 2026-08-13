import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it, vi } from "vitest";
import { type HeadlessLlmRequest, withHeadlessPi } from "./headless-pi.ts";

function readProcessState(pid: number): string | undefined {
	try {
		return readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

it.skipIf(process.platform !== "linux")(
	"reaps active memory enrichment before process restart",
	async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-memory-enrich-restart-"));
		const executablePath = join(tempDir, "claude-memory");
		const invocationPath = join(tempDir, "invocations");
		const pidPath = join(tempDir, "child.pid");
		let childPid: number | undefined;
		writeFileSync(
			executablePath,
			`#!/usr/bin/env node\n` +
				`const fs = require("node:fs");\n` +
				`let invocation = 0;\n` +
				`try { invocation = Number(fs.readFileSync(${JSON.stringify(invocationPath)}, "utf8")); } catch {}\n` +
				`invocation += 1;\n` +
				`fs.writeFileSync(${JSON.stringify(invocationPath)}, String(invocation));\n` +
				`if (invocation === 1) {\n` +
				`  fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\n` +
				`  process.stdin.resume();\n` +
				`  process.on("SIGTERM", () => setTimeout(() => process.exit(0), 50));\n` +
				`  setInterval(() => {}, 1_000);\n` +
				`} else {\n` +
				`  process.stdout.write("{}\\n");\n` +
				`}\n`,
		);
		chmodSync(executablePath, 0o755);

		try {
			await withHeadlessPi(
				async (agent) => {
					const interruptedPrompt = agent
						.send({ type: "prompt", message: "Hold enrichment open across restart" })
						.then(
							() => undefined,
							(error: unknown) => error,
						);
					await vi.waitFor(() => expect(existsSync(pidPath)).toBe(true), { timeout: 2_000 });
					const activeChildPid = Number(readFileSync(pidPath, "utf8"));
					childPid = activeChildPid;
					expect(readProcessState(activeChildPid)).not.toBe("Z");

					await agent.restart();
					expect(await interruptedPrompt).toBeInstanceOf(Error);

					await vi.waitFor(() => expect(readProcessState(activeChildPid)).toBeUndefined(), { timeout: 2_000 });
					let request: HeadlessLlmRequest;
					try {
						request = await agent.waitForLlmRequest((candidate) => candidate.agentId === null, 500);
					} catch (error) {
						if (!(error instanceof Error) || !error.message.includes("Timed out waiting for LLM request"))
							throw error;
						await agent.send({ type: "prompt", message: "Confirm Pi remains healthy after restart" });
						request = await agent.waitForLlmRequest((candidate) => candidate.agentId === null);
					}
					agent.respondToLlmRequest(
						request.id,
						fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Restart cleanup complete" }), {
							stopReason: "toolUse",
						}),
					);
					await agent.waitForEvent((event) => event.type === "agent_end");
				},
				{ enableMemoryEnrichment: true, env: { PI_CLAUDE_MEMORY: executablePath } },
			);
		} finally {
			if (childPid !== undefined && readProcessState(childPid) !== undefined) process.kill(childPid, "SIGKILL");
			rmSync(tempDir, { recursive: true, force: true });
		}
	},
	30_000,
);
