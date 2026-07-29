import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { getControlDbPath, readSessionMetadata } from "../../../src/core/session-control-db.ts";
import { withHeadlessPi } from "../headless-pi.ts";

it("continues an interrupted self-restart from an existing parent after its cwd was deleted", async () => {
	await withHeadlessPi(
		async (agent) => {
			const deletedCwd = agent.paths.workspaceDir;
			const fallbackCwd = dirname(deletedCwd);
			await agent.send({ type: "prompt", message: "Restart after deleting this working directory" });
			const beforeRestart = await agent.waitForLlmRequest((request) => request.agentId === null);

			agent.respondToLlmRequest(
				beforeRestart.id,
				fauxAssistantMessage(fauxToolCall("restart_self", {}), { stopReason: "toolUse" }),
			);

			const afterRestart = await agent.waitForLlmRequest((request) => request.agentId === null, 10_000);
			expect(afterRestart.sessionId).toBe(agent.sessionId);
			expect(existsSync(deletedCwd)).toBe(false);
			expect(readSessionMetadata(getControlDbPath(agent.paths.agentDir), agent.sessionFile)?.cwd).toBe(fallbackCwd);
			expect(JSON.stringify(afterRestart.messages)).not.toContain(
				"Continue from the restored session after restart.",
			);

			agent.respondToLlmRequest(afterRestart.id, fauxAssistantMessage("continued from fallback cwd"));
			await agent.waitForSessionEntry(
				null,
				(entry) =>
					entry.type === "message" && JSON.stringify(entry.message).includes("continued from fallback cwd"),
			);

			const entries = agent.readSessionEntries(null);
			expect(
				entries.filter((entry) => entry.type === "custom_message" && entry.customType === "self_restart"),
			).toHaveLength(1);
			expect(entries.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
		},
		{ deleteCwdBeforeSelfRestart: true },
	);
}, 30_000);
