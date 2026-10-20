import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";

it("isolates queue subscribers after supervisor restart while a child remains live", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-listener-process-"));
	const armedPath = join(tempDir, "armed");
	const logPath = join(tempDir, "events.jsonl");
	writeFileSync(logPath, "");
	try {
		await withHeadlessPi(
			async (pi) => {
				await pi.send({ type: "prompt", message: "Delegate listener regression" });
				const initial = await pi.waitForLlmRequest((request) => request.agentId === null);
				pi.respondToLlmRequest(
					initial.id,
					fauxAssistantMessage(
						fauxToolCall("spawn_agent", {
							context: "fresh",
							displayName: "Listener isolation child",
							prompt: "Preserve this live assignment",
						}),
						{ stopReason: "toolUse" },
					),
				);
				const child = await pi.waitForAgent(
					(agent) => agent.displayName === "Listener isolation child" && agent.lifecycle === "running",
				);
				await pi.waitForLlmRequest((request) => request.agentId === child.id);
				const afterSpawn = await pi.waitForLlmRequest(
					(request) => request.agentId === null && request.id !== initial.id,
				);
				pi.respondToLlmRequest(
					afterSpawn.id,
					fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Child remains live" }), {
						stopReason: "toolUse",
					}),
				);
				await pi.waitForEvent((event) => event.type === "agent_end");

				const sessionId = pi.sessionId;
				const transcript = child.transcript;
				await pi.restart();
				expect(pi.sessionId).toBe(sessionId);
				expect(pi.listAgents().find((agent) => agent.id === child.id)).toMatchObject({
					lifecycle: "running",
					transcript,
				});
				writeFileSync(armedPath, "armed");
				writeFileSync(logPath, "");
				expect(await pi.send({ type: "abort" })).toMatchObject({ success: true });
				const logged = readFileSync(logPath, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				expect(logged).toEqual([
					{ type: "reported", error: "Error: headless queue subscriber failed" },
					{ type: "queue_update", sessionId },
				]);
				expect(pi.listAgents().find((agent) => agent.id === child.id)).toMatchObject({
					lifecycle: "running",
					transcript,
				});

				await pi.send({ type: "prompt", message: "Continue after listener failure" });
				const continued = await pi.waitForLlmRequest((request) => request.agentId === null);
				pi.respondToLlmRequest(
					continued.id,
					fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Session remains usable" }), {
						stopReason: "toolUse",
					}),
				);
				await pi.waitForEvent((event) => event.type === "agent_end");
			},
			{
				cliPath: join(import.meta.dirname, "../fixtures/throwing-session-listener-cli.ts"),
				env: { PI_TEST_LISTENER_ARMED: armedPath, PI_TEST_LISTENER_LOG: logPath },
			},
		);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}, 60_000);
