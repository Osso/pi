import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { type HeadlessPi, withHeadlessPi } from "../headless-pi.ts";

function respondWithInterruptibleMessage(agent: HeadlessPi, requestId: string, marker: string): void {
	agent.respondToLlmRequest(
		requestId,
		fauxAssistantMessage(
			[
				fauxThinking("Concrete streamed reasoning"),
				{ type: "text", text: "Visible answer before interruption" },
				fauxToolCall("pyrun_eval", {
					code: `open(${JSON.stringify(marker)}, "w").write("executed")`,
				}),
			],
			{ stopReason: "toolUse" },
		),
	);
}

async function collectThroughFirstToolDelta(agent: HeadlessPi, events: AgentSessionEvent[]): Promise<AssistantMessage> {
	while (true) {
		const event = await agent.waitForEvent(() => true);
		events.push(event);
		if (event.type !== "message_update" || event.message.role !== "assistant") continue;
		if (event.assistantMessageEvent.type === "toolcall_delta") return structuredClone(event.message);
	}
}

async function completeOrderedInputs(agent: HeadlessPi): Promise<void> {
	await agent.send({ type: "follow_up", message: "Second queued input" });
	await agent.send({ type: "steer", message: "First queued input" });
	const second = await agent.waitForLlmRequest();
	expect(second.userMessages).toEqual(["Original request", "First queued input"]);
	agent.respondToLlmRequest(
		second.id,
		fauxAssistantMessage(
			[{ type: "text", text: "First handled" }, fauxToolCall("end_turn", { reason: "First handled" })],
			{ stopReason: "toolUse" },
		),
	);
	const third = await agent.waitForLlmRequest();
	expect(third.userMessages).toEqual(["Original request", "First queued input", "Second queued input"]);
	agent.respondToLlmRequest(
		third.id,
		fauxAssistantMessage(
			[{ type: "text", text: "Second handled" }, fauxToolCall("end_turn", { reason: "Second handled" })],
			{ stopReason: "toolUse" },
		),
	);
}

async function collectThroughFinalAgentEnd(agent: HeadlessPi, events: AgentSessionEvent[]): Promise<void> {
	let finalMessageEnded = false;
	while (true) {
		const event = await agent.waitForEvent(() => true);
		events.push(event);
		if (event.type === "message_end" && event.message.role === "assistant") {
			finalMessageEnded ||= event.message.content.some(
				(part) => part.type === "text" && part.text === "Second handled",
			);
		}
		if (finalMessageEnded && event.type === "agent_end") return;
	}
}

function assertInterruptedAssistantPreserved(
	events: AgentSessionEvent[],
	streamed: AssistantMessage,
	marker: string,
): AssistantMessage[] {
	const starts = events.filter((event) => event.type === "message_start" && event.message.role === "assistant");
	const ends = events.filter((event) => event.type === "message_end" && event.message.role === "assistant");
	expect(starts).toHaveLength(3);
	expect(ends).toHaveLength(3);
	const messages = ends.map((event) => {
		if (event.type !== "message_end" || event.message.role !== "assistant")
			throw new Error("Expected assistant message_end");
		return event.message;
	});
	const interrupted = messages[0];
	if (!interrupted) throw new Error("Missing interrupted assistant end");
	expect(interrupted.stopReason).toBe("aborted");
	expect(interrupted.timestamp).toBe(streamed.timestamp);
	expect(interrupted.content.filter((part) => part.type !== "toolCall")).toEqual(
		streamed.content.filter((part) => part.type !== "toolCall"),
	);
	expect(events.filter((event) => event.type === "tool_execution_start" && event.toolName === "pyrun_eval")).toEqual(
		[],
	);
	expect(existsSync(marker)).toBe(false);
	return messages;
}

async function assertSessionSurvivesCrash(agent: HeadlessPi, endedMessages: AssistantMessage[], marker: string) {
	const sessionFile = agent.sessionFile;
	const persisted = SessionManager.open(sessionFile).buildSessionContext().messages;
	expect(persisted.filter((message) => message.role === "assistant")).toEqual(endedMessages);
	await agent.crash();
	await agent.restart();
	expect(agent.sessionFile).toBe(sessionFile);
	const restored = await agent.send({ type: "get_messages" });
	expect(restored.success).toBe(true);
	if (!restored.success || restored.command !== "get_messages") throw new Error("Failed to read restored messages");
	expect(restored.data.messages).toEqual(persisted);
	expect(existsSync(marker)).toBe(false);
}

it("preserves streamed text and thinking exactly once across interrupt, ordered steering, and process reload", async () => {
	await withHeadlessPi(
		async (agent) => {
			const events: AgentSessionEvent[] = [];
			await agent.send({ type: "prompt", message: "Original request" });
			const first = await agent.waitForLlmRequest();
			const marker = join(agent.paths.workspaceDir, "interrupted-tool-ran");
			respondWithInterruptibleMessage(agent, first.id, marker);
			const streamed = await collectThroughFirstToolDelta(agent, events);
			expect(streamed.content).toContainEqual(fauxThinking("Concrete streamed reasoning"));
			expect(streamed.content).toContainEqual({ type: "text", text: "Visible answer before interruption" });
			await completeOrderedInputs(agent);
			await collectThroughFinalAgentEnd(agent, events);
			const endedMessages = assertInterruptedAssistantPreserved(events, streamed, marker);
			await assertSessionSurvivesCrash(agent, endedMessages, marker);
		},
		{ cliPath: join(import.meta.dirname, "../fixtures/streaming-preservation-cli.ts") },
	);
}, 90_000);
