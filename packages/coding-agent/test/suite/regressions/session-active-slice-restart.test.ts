import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { getControlDbPath, readSessionMetadata, writeSessionMetadata } from "../../../src/core/session-control-db.ts";
import type { SessionMessageEntry } from "../../../src/core/session-manager.ts";
import { withHeadlessPi } from "../headless-pi.ts";

function userEntry(id: string, parentId: string | null, content: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-07-24T00:00:00.000Z",
		message: { role: "user", content, timestamp: 1 },
	};
}

it("restores a compacted active slice and session state after process replacement", async () => {
	await withHeadlessPi(
		async (agent) => {
			await agent.crash();
			const relocatedCwd = join(agent.paths.tempDir, "relocated");
			mkdirSync(relocatedCwd, { recursive: true });
			writeFileSync(join(relocatedCwd, "cwd-marker.txt"), "relocated cwd");

			const entries = [
				{
					type: "session",
					version: 3,
					id: agent.sessionId,
					timestamp: "2026-07-24T00:00:00.000Z",
					cwd: agent.paths.workspaceDir,
				},
				userEntry("summarized", null, "summarized prefix"),
				userEntry("abandoned", "summarized", "abandoned branch"),
				userEntry("kept", "summarized", "retained branch"),
				{
					type: "custom_message",
					id: "cwd-change",
					parentId: "kept",
					timestamp: "2026-07-24T00:00:00.000Z",
					customType: "cwd_changed",
					content: `Working directory changed to ${relocatedCwd}.`,
					details: { previousCwd: agent.paths.workspaceDir, cwd: relocatedCwd },
					display: true,
				},
				{
					type: "compaction",
					id: "compaction",
					parentId: "cwd-change",
					timestamp: "2026-07-24T00:00:00.000Z",
					summary: "summary",
					firstKeptEntryId: "kept",
					tokensBefore: 1000,
				},
				userEntry("after", "compaction", "active suffix"),
			];
			writeFileSync(agent.sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

			const settingsPath = join(agent.paths.agentDir, "settings.json");
			const configuredDefaults = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
			writeFileSync(
				settingsPath,
				JSON.stringify({
					...configuredDefaults,
					defaultProvider: "headless-faux",
					defaultModel: "headless-faux-1",
					defaultThinkingLevel: "off",
				}),
			);

			const controlDbPath = getControlDbPath(agent.paths.agentDir);
			const previousMetadata = readSessionMetadata(controlDbPath, agent.sessionFile);
			writeSessionMetadata(controlDbPath, {
				sessionPath: agent.sessionFile,
				id: agent.sessionId,
				cwd: relocatedCwd,
				createdAt: previousMetadata?.createdAt ?? "2026-07-24T00:00:00.000Z",
				modifiedAt: "2026-07-24T00:01:00.000Z",
				messageCount: 3,
				firstMessage: "summarized prefix",
				allMessagesText: "summarized prefix abandoned branch retained branch active suffix",
				modelProvider: "headless-faux",
				modelId: "headless-faux-reasoning",
				thinkingLevel: "high",
			});

			await agent.restart();

			expect(agent.readSessionEntries(null).map((entry) => entry.id)).toEqual([
				"kept",
				"cwd-change",
				"compaction",
				"after",
			]);
			const rawTranscript = readFileSync(agent.sessionFile, "utf8");
			expect(rawTranscript).toContain('"id":"summarized"');
			expect(rawTranscript).toContain('"id":"abandoned"');

			const state = await agent.send({ type: "get_state" });
			expect(state).toMatchObject({
				command: "get_state",
				success: true,
				data: { model: { id: "headless-faux-reasoning" }, thinkingLevel: "high" },
			});
			expect(readSessionMetadata(controlDbPath, agent.sessionFile)).toMatchObject({
				cwd: relocatedCwd,
				modelProvider: "headless-faux",
				modelId: "headless-faux-reasoning",
				thinkingLevel: "high",
			});
			expect(
				agent
					.readSessionEntries(null)
					.filter((entry) => entry.type === "model_change" || entry.type === "thinking_level_change"),
			).toEqual([]);

			const request = await agent.waitForLlmRequest((candidate) => candidate.agentId === null);
			agent.respondToLlmRequest(
				request.id,
				fauxAssistantMessage(fauxToolCall("read", { path: "cwd-marker.txt" }), { stopReason: "toolUse" }),
			);
			const resultRequest = await agent.waitForLlmRequest(
				(candidate) => candidate.agentId === null && candidate.id !== request.id,
			);
			expect(JSON.stringify(resultRequest.messages)).toContain("relocated cwd");
			agent.respondToLlmRequest(resultRequest.id, fauxAssistantMessage("done"));
		},
		{ model: false },
	);
}, 30_000);
