import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { requireHeadlessAgentSessionId, withHeadlessPi } from "./headless-pi.ts";

it("compacts at 50% after a tool result with a live child preserved across supervisor restart", async () => {
	await withHeadlessPi(async (runtime) => {
		const mainSessionId = runtime.sessionId;
		await runtime.send({ type: "prompt", message: "Record prior completed work" });
		const history = await runtime.waitForLlmRequest((request) => request.agentId === null);
		runtime.respondToLlmRequest(
			history.id,
			fauxAssistantMessage(
				[
					{ type: "text", text: "Prior completed work must be summarized" },
					fauxToolCall("end_turn", { reason: "history complete" }),
				],
				{ stopReason: "toolUse" },
			),
		);
		await runtime.waitForEvent((event) => event.type === "agent_end");
		await runtime.send({ type: "prompt", message: "Keep the parallel worker alive" });
		const spawn = await runtime.waitForLlmRequest((request) => request.agentId === null);
		runtime.respondToLlmRequest(
			spawn.id,
			fauxAssistantMessage(
				fauxToolCall("spawn_agent", {
					context: "fresh",
					displayName: "Live50 worker",
					prompt: "Preserve this parallel assignment until released",
				}),
				{ stopReason: "toolUse" },
			),
		);
		const child = await runtime.waitForAgent((agent) => agent.displayName === "Live50 worker");
		const childSessionId = requireHeadlessAgentSessionId(child);
		await runtime.waitForLlmRequest((request) => request.sessionId === childSessionId);
		await runtime.waitForLlmRequest((request) => request.agentId === null);

		const settingsPath = join(runtime.paths.agentDir, "settings.json");
		const settings: Record<string, unknown> = JSON.parse(readFileSync(settingsPath, "utf8"));
		writeFileSync(
			settingsPath,
			JSON.stringify({
				...settings,
				compaction: { enabled: false, thresholdPercent: 50, keepRecentTokens: 1, reserveTokens: 100 },
			}),
		);
		const effectPath = join(runtime.paths.workspaceDir, "live50-effects");
		writeFileSync(
			join(runtime.paths.agentDir, "extensions", "live50-fixture.ts"),
			`
import { appendFileSync } from "node:fs";
import { Type } from "typebox";
export default function (pi) {
	pi.registerTool({
		name: "live_effect", label: "Live effect", description: "Record a single test effect",
		parameters: Type.Object({}),
		execute: async () => {
			appendFileSync(${JSON.stringify(effectPath)}, "effect\\n");
			return { content: [{ type: "text", text: "effect recorded" }], details: {} };
		},
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant" || !event.message.content.some((block) => block.type === "toolCall" && block.name === "live_effect")) return;
		return { message: { ...event.message, usage: {
			input: 64000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 64000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		} } };
	});
	pi.on("compaction", (event) => ({ compaction: {
		summary: "Live50 summary; parallel assignment remains active",
		firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
	} }));
}
`,
		);
		await runtime.crash();
		await runtime.restart();
		const restoredChild = await runtime.waitForLlmRequest((request) => request.sessionId === childSessionId);
		const restoredMain = await runtime.waitForLlmRequest((request) => request.agentId === null);
		expect(runtime.sessionId).toBe(mainSessionId);
		expect(restoredChild.userMessages).toContain("Preserve this parallel assignment until released");
		expect(runtime.listAgents().find((agent) => agent.id === child.id)?.transcript).toEqual(child.transcript);
		runtime.respondToLlmRequest(
			restoredMain.id,
			fauxAssistantMessage(fauxToolCall("live_effect", {}, { id: "live50-effect" }), { stopReason: "toolUse" }),
		);

		const continued = await runtime.waitForLlmRequest((request) => request.agentId === null);
		expect(runtime.readSessionEntries(null).filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(JSON.stringify(continued.messages)).toContain("Live50 summary; parallel assignment remains active");
		expect(JSON.stringify(continued.messages)).not.toContain("Prior completed work must be summarized");
		const callIndex = continued.messages.findIndex(
			(message) =>
				message.role === "assistant" &&
				message.content.some((block) => block.type === "toolCall" && block.id === "live50-effect"),
		);
		const resultIndex = continued.messages.findIndex(
			(message) => message.role === "toolResult" && message.toolCallId === "live50-effect",
		);
		expect(callIndex).toBeGreaterThanOrEqual(0);
		expect(resultIndex).toBeGreaterThan(callIndex);
		expect(readFileSync(effectPath, "utf8")).toBe("effect\n");
		expect(runtime.listAgents().find((agent) => agent.id === child.id)).toMatchObject({
			lifecycle: "running",
			transcript: child.transcript,
		});
		runtime.respondToLlmRequest(
			continued.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "boundary verified" }), { stopReason: "toolUse" }),
		);
		await runtime.waitForEvent((event) => event.type === "agent_end");
		runtime.respondToLlmRequest(
			restoredChild.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "assignment complete" }), { stopReason: "toolUse" }),
		);
		await runtime.waitForAgent((agent) => agent.id === child.id && agent.lifecycle === "completed");
	});
}, 60_000);
