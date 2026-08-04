import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { getControlDbPath, readSessionMetadata, writeSessionMetadata } from "../../../src/core/session-control-db.ts";
import type { SessionMessageEntry } from "../../../src/core/session-manager.ts";
import { type HeadlessPi, withHeadlessPi } from "../headless-pi.ts";

function userEntry(id: string, parentId: string | null, content: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-07-24T00:00:00.000Z",
		message: { role: "user", content, timestamp: 1 },
	};
}

function fauxEndTurn(reason: string, id: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage(fauxToolCall("end_turn", { reason }, { id }), { stopReason: "toolUse" });
}

function expectActiveSlice(agent: HeadlessPi): void {
	expect(
		agent
			.readSessionEntries(null)
			.slice(0, 4)
			.map((entry) => entry.id),
	).toEqual(["kept", "cwd-change", "compaction", "after"]);
}

function expectSummarizedPrefix(agent: HeadlessPi): void {
	const transcript = readFileSync(agent.sessionFile, "utf8");
	expect(transcript).toContain('"id":"summarized"');
	expect(transcript).toContain('"id":"abandoned"');
}

function expectNoLegacySettingEntries(agent: HeadlessPi): void {
	const legacyEntries = agent
		.readSessionEntries(null)
		.filter((entry) => entry.type === "model_change" || entry.type === "thinking_level_change");
	expect(legacyEntries).toEqual([]);
}

async function waitForToolResult(agent: HeadlessPi, toolCallId: string): Promise<void> {
	await agent.waitForSessionEntry(
		null,
		(entry) =>
			entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === toolCallId,
	);
}

async function relocateCompactedSession(agent: HeadlessPi, finalCwd: string): Promise<void> {
	const relocationRequest = await agent.waitForLlmRequest((candidate) => candidate.agentId === null);
	agent.respondToLlmRequest(
		relocationRequest.id,
		fauxAssistantMessage(
			fauxToolCall("change_working_directory", { path: finalCwd }, { id: "relocate-compacted-session" }),
			{ stopReason: "toolUse" },
		),
	);
	await agent.waitForSessionEntry(
		null,
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "cwd_changed" &&
			typeof entry.content === "string" &&
			entry.content.includes(finalCwd),
	);
	const settlementRequest = await agent.waitForLlmRequest(
		(candidate) => candidate.agentId === null && candidate.id !== relocationRequest.id,
	);
	agent.respondToLlmRequest(
		settlementRequest.id,
		fauxEndTurn("Compacted session relocation settled", "end-compacted-relocation"),
	);
	await waitForToolResult(agent, "end-compacted-relocation");
	await agent.waitForEvent((event) => event.type === "agent_end");
}

async function expectCurrentCwdMarker(agent: HeadlessPi): Promise<void> {
	await agent.send({ type: "prompt", message: "Read cwd-marker.txt" });
	const readRequest = await agent.waitForLlmRequest((candidate) => candidate.agentId === null);
	agent.respondToLlmRequest(
		readRequest.id,
		fauxAssistantMessage(fauxToolCall("read", { path: "cwd-marker.txt" }), { stopReason: "toolUse" }),
	);
	const resultRequest = await agent.waitForLlmRequest(
		(candidate) => candidate.agentId === null && candidate.id !== readRequest.id,
	);
	expect(JSON.stringify(resultRequest.messages)).toContain("final relocated cwd");
	agent.respondToLlmRequest(resultRequest.id, fauxEndTurn("Relocated cwd read verified", "end-relocated-read"));
	await waitForToolResult(agent, "end-relocated-read");
}

it("restores and relocates a compacted active slice across process replacement", async () => {
	await withHeadlessPi(
		async (agent) => {
			await agent.crash();
			const relocatedCwd = join(agent.paths.tempDir, "relocated");
			const finalCwd = join(agent.paths.tempDir, "final-relocated");
			mkdirSync(relocatedCwd, { recursive: true });
			mkdirSync(finalCwd, { recursive: true });
			writeFileSync(join(finalCwd, "cwd-marker.txt"), "final relocated cwd");

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

			expectActiveSlice(agent);
			expectSummarizedPrefix(agent);

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
			expectNoLegacySettingEntries(agent);

			await relocateCompactedSession(agent, finalCwd);

			expectSummarizedPrefix(agent);
			expect(readSessionMetadata(controlDbPath, agent.sessionFile)).toMatchObject({ cwd: finalCwd });

			await agent.restart();

			expectActiveSlice(agent);
			expectSummarizedPrefix(agent);
			expect(readSessionMetadata(controlDbPath, agent.sessionFile)).toMatchObject({ cwd: finalCwd });

			await expectCurrentCwdMarker(agent);
		},
		{ model: false },
	);
}, 30_000);
