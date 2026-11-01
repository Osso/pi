import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { withHeadlessPi } from "./headless-pi.ts";

const PARENT_MARKER = "PARENT_MARKER_7f3";

/** The default explore profile names a real provider; route it to the offline faux provider. */
function useFauxExploreProfile(agentDir: string): void {
	const settingsPath = join(agentDir, "settings.json");
	const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
	writeFileSync(
		settingsPath,
		JSON.stringify({
			...settings,
			agents: { explore: { model: "headless-faux/headless-faux-1", thinkingLevel: "off" } },
		}),
	);
}

function toolResultText(messages: Message[], toolName: string): string {
	const result = messages.find((message) => message.role === "toolResult" && message.toolName === toolName);
	if (!result || result.role !== "toolResult") throw new Error(`Missing ${toolName} result`);
	expect(result.isError, `${toolName} result`).toBe(false);
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function endTurn(reason: string) {
	return fauxAssistantMessage([{ type: "text", text: reason }, fauxToolCall("end_turn", { reason })], {
		stopReason: "toolUse",
	});
}

describe("child observation of its parent session", () => {
	it("lets a spawned child list the parent's agents and find a parent tool call in the parent's history", async () => {
		await withHeadlessPi(async (agent) => {
			useFauxExploreProfile(agent.paths.agentDir);
			await agent.restart();
			await agent.send({ type: "prompt", message: "Read the marker file, then spawn an observer." });
			const first = await agent.waitForLlmRequest((request) => request.agentId === null);
			expect(first.tools?.map((tool) => tool.name)).not.toContain("search_parent_session_history");
			agent.respondToLlmRequest(
				first.id,
				fauxAssistantMessage(fauxToolCall("read", { path: `${PARENT_MARKER}.txt` }), { stopReason: "toolUse" }),
			);
			const second = await agent.waitForLlmRequest((request) => request.agentId === null && request.id !== first.id);
			agent.respondToLlmRequest(
				second.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						agentType: "explore",
						context: "fresh",
						displayName: "parent-observer",
						prompt: "Report what the parent did.",
					}),
					{ stopReason: "toolUse" },
				),
			);

			const child = await agent.waitForAgent((candidate) => candidate.displayName === "parent-observer");
			const childFirst = await agent.waitForLlmRequest((request) => request.agentId === child.id);
			const childTools = childFirst.tools?.map((tool) => tool.name);
			expect(childTools).toContain("list_agents");
			expect(childTools).toContain("search_parent_session_history");
			agent.respondToLlmRequest(
				childFirst.id,
				fauxAssistantMessage(
					[
						fauxToolCall("list_agents", {}),
						fauxToolCall("search_parent_session_history", { query: PARENT_MARKER }),
					],
					{ stopReason: "toolUse" },
				),
			);
			const childSecond = await agent.waitForLlmRequest(
				(request) => request.agentId === child.id && request.id !== childFirst.id,
			);

			expect(toolResultText(childSecond.messages, "list_agents")).toContain(
				`id=${child.id} name="parent-observer" type=explore`,
			);
			const parentHistory = JSON.parse(toolResultText(childSecond.messages, "search_parent_session_history")) as {
				totalMatches: number;
				entries: { role: string; matched: boolean; content: unknown }[];
			};
			const matchedCall = parentHistory.entries.find(
				(entry) => entry.matched && entry.role === "assistant" && JSON.stringify(entry.content).includes('"read"'),
			);
			expect(JSON.stringify(matchedCall?.content)).toContain(`${PARENT_MARKER}.txt`);
			agent.respondToLlmRequest(childSecond.id, endTurn("Parent read the marker file."));

			const parentAfterSpawn = await agent.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== first.id && request.id !== second.id,
			);
			agent.respondToLlmRequest(parentAfterSpawn.id, endTurn("Observer spawned."));
			await agent.waitForAgent((candidate) => candidate.id === child.id && candidate.lifecycle === "completed");
		});
	}, 120_000);
});
