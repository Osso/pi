import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { getControlDbPath, readSessionNameState, writeSessionName } from "../../../src/core/session-control-db.ts";
import { type HeadlessPi, withHeadlessPi } from "../headless-pi.ts";

function completedResponse(text: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })], {
		stopReason: "toolUse",
	});
}

async function finishMainTurn(agent: HeadlessPi, prompt: string, response: string): Promise<void> {
	await agent.send({ type: "prompt", message: prompt });
	const request = await agent.waitForLlmRequest(
		(candidate) =>
			candidate.agentId === null &&
			candidate.sessionId === agent.sessionId &&
			candidate.userMessages.includes(prompt),
	);
	agent.respondToLlmRequest(request.id, completedResponse(response));
	await agent.waitForEvent((event) => event.type === "agent_end");
}

async function callSessionNameTool(
	agent: HeadlessPi,
	prompt: string,
	name: string,
	toolCallId: string,
): Promise<boolean> {
	await agent.send({ type: "prompt", message: prompt });
	const request = await agent.waitForLlmRequest(
		(candidate) =>
			candidate.agentId === null &&
			candidate.sessionId === agent.sessionId &&
			candidate.userMessages.includes(prompt),
	);
	agent.respondToLlmRequest(
		request.id,
		fauxAssistantMessage(fauxToolCall("set_session_name", { name }, { id: toolCallId }), {
			stopReason: "toolUse",
		}),
	);

	const resultRequest = await agent.waitForLlmRequest(
		(candidate) =>
			candidate.agentId === null &&
			candidate.sessionId === agent.sessionId &&
			candidate.messages.some((message) => message.role === "toolResult" && message.toolCallId === toolCallId),
	);
	const toolResult = resultRequest.messages.find(
		(message) => message.role === "toolResult" && message.toolCallId === toolCallId,
	);
	if (!toolResult || toolResult.role !== "toolResult") throw new Error(`Missing tool result ${toolCallId}`);

	agent.respondToLlmRequest(resultRequest.id, completedResponse("The session-name tool result was handled."));
	await agent.waitForEvent((event) => event.type === "agent_end");
	return toolResult.isError;
}

async function startUnnamedSession(agent: HeadlessPi): Promise<string> {
	await finishMainTurn(agent, "Initialize the unnamed session metadata", "Unnamed session initialized.");
	const controlDbPath = getControlDbPath(agent.paths.agentDir);
	expect(readSessionNameState(controlDbPath, agent.sessionFile)).toEqual({
		name: undefined,
		hasStoredValue: false,
	});
	return controlDbPath;
}

async function expectExternalNameToRemain(
	agent: HeadlessPi,
	controlDbPath: string,
	expectedState: { name: string | undefined; hasStoredValue: boolean },
	prompt: string,
	requestedName: string,
	toolCallId: string,
): Promise<void> {
	expect(await callSessionNameTool(agent, prompt, requestedName, toolCallId)).toBe(true);
	expect(readSessionNameState(controlDbPath, agent.sessionFile)).toEqual(expectedState);

	await finishMainTurn(agent, `${prompt}: follow-up turn`, "Follow-up main turn completed.");
	expect(await agent.send({ type: "get_last_assistant_text" })).toMatchObject({
		command: "get_last_assistant_text",
		success: true,
		data: { text: "Follow-up main turn completed." },
	});
	expect(readSessionNameState(controlDbPath, agent.sessionFile)).toEqual(expectedState);
}

it("preserves a distinct external name written to a live unnamed session", async () => {
	await withHeadlessPi(
		async (agent) => {
			const controlDbPath = await startUnnamedSession(agent);
			const expectedState = { name: "Picker-owned campaign", hasStoredValue: true };
			writeSessionName(controlDbPath, agent.sessionFile, expectedState.name);
			expect(readSessionNameState(controlDbPath, agent.sessionFile)).toEqual(expectedState);

			await expectExternalNameToRemain(
				agent,
				controlDbPath,
				expectedState,
				"Try to rename after the external picker rename",
				"Model-owned campaign",
				"external-distinct-name",
			);
		},
		{ noSessionName: true },
	);
});

it("preserves an external clear after the live session was named", async () => {
	await withHeadlessPi(
		async (agent) => {
			const controlDbPath = await startUnnamedSession(agent);
			expect(
				await callSessionNameTool(
					agent,
					"Set the initial session name",
					"Tool-owned title before clear",
					"name-before-clear",
				),
			).toBe(false);
			const expectedState = { name: undefined, hasStoredValue: true };
			writeSessionName(controlDbPath, agent.sessionFile, undefined);
			expect(readSessionNameState(controlDbPath, agent.sessionFile)).toEqual(expectedState);

			await expectExternalNameToRemain(
				agent,
				controlDbPath,
				expectedState,
				"Try to rename after the external picker clear",
				"Model-owned title after clear",
				"external-clear-name",
			);
		},
		{ noSessionName: true },
	);
});

it("preserves an external same-title write after the live session was named", async () => {
	await withHeadlessPi(
		async (agent) => {
			const controlDbPath = await startUnnamedSession(agent);
			const sameTitle = "Tool-owned title rewritten by picker";
			expect(
				await callSessionNameTool(
					agent,
					"Set the session name before picker write",
					sameTitle,
					"name-before-same-title-write",
				),
			).toBe(false);
			const expectedState = { name: sameTitle, hasStoredValue: true };
			writeSessionName(controlDbPath, agent.sessionFile, sameTitle);
			expect(readSessionNameState(controlDbPath, agent.sessionFile)).toEqual(expectedState);

			await expectExternalNameToRemain(
				agent,
				controlDbPath,
				expectedState,
				"Try to rename after the external same-title write",
				"Model-owned title after same-title write",
				"external-same-title-name",
			);
		},
		{ noSessionName: true },
	);
});
