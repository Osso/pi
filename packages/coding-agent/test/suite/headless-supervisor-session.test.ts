import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	getControlDbPath,
	postSupervisorRequest,
	readSupervisorRequest,
	type SupervisorRequest,
} from "../../src/core/session-control-db.ts";
import { notifySupervisorRequest } from "../../src/supervisor/request-wake.ts";
import { type HeadlessLlmRequest, type HeadlessPi, withHeadlessPi } from "./headless-pi.ts";

function makeSupervisorSession(agent: HeadlessPi): void {
	const settingsPath = join(agent.paths.agentDir, "settings.json");
	const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
	writeFileSync(settingsPath, JSON.stringify({ ...settings, supervisor: { sessionId: agent.sessionId } }));
}

function postAdvisory(agent: HeadlessPi, marker: string): number {
	const controlDbPath = getControlDbPath(agent.paths.agentDir);
	const id = postSupervisorRequest(controlDbPath, {
		deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		kind: "supervisor_advisory",
		payload: { question: `Advice for ${marker}?` },
		projectId: "pi",
		senderSessionId: "asking-session",
	});
	notifySupervisorRequest(controlDbPath);
	return id;
}

function asksAbout(marker: string): (request: HeadlessLlmRequest) => boolean {
	return (request) => JSON.stringify(request.messages.at(-1) ?? null).includes(`Advice for ${marker}?`);
}

function answer(agent: HeadlessPi, request: HeadlessLlmRequest, text: string): void {
	agent.respondToLlmRequest(
		request.id,
		fauxAssistantMessage([fauxToolCall("supervisor_response", { kind: "advisory", answer: text })], {
			stopReason: "toolUse",
		}),
	);
}

async function waitForCompletion(agent: HeadlessPi, id: number): Promise<SupervisorRequest> {
	const deadline = Date.now() + 20_000;
	for (;;) {
		const request = readSupervisorRequest(getControlDbPath(agent.paths.agentDir), id);
		if (request?.status === "completed") return request;
		if (Date.now() > deadline) throw new Error(`Request ${id} not completed: ${request?.status}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("headless interactive Supervisor session", () => {
	it("serves queued requests in a real Pi process and reruns a claimed request after restart", async () => {
		await withHeadlessPi(async (agent) => {
			// A session file exists only after its first turn, and restart resumes that file.
			await agent.send({ type: "prompt", message: "Start the Supervisor session" });
			agent.respondToLlmRequest((await agent.waitForLlmRequest()).id, fauxAssistantMessage("Ready."));
			await agent.waitForSessionEntry(
				null,
				(entry) => entry.type === "message" && entry.message.role === "assistant",
			);
			makeSupervisorSession(agent);
			await agent.restart();
			expect(agent.sessionId).toBe(
				JSON.parse(readFileSync(join(agent.paths.agentDir, "settings.json"), "utf8")).supervisor.sessionId,
			);

			const first = postAdvisory(agent, "first");
			answer(agent, await agent.waitForLlmRequest(asksAbout("first")), "Use the spec.");
			expect((await waitForCompletion(agent, first)).response).toEqual({
				kind: "advisory",
				answer: "Use the spec.",
			});

			const second = postAdvisory(agent, "second");
			await agent.waitForLlmRequest(asksAbout("second"));
			expect(readSupervisorRequest(getControlDbPath(agent.paths.agentDir), second)?.status).toBe("claimed");
			await agent.restart();

			const rerun = await agent.waitForLlmRequest(asksAbout("second"));
			answer(agent, rerun, "Rerun after restart.");
			expect((await waitForCompletion(agent, second)).response).toEqual({
				kind: "advisory",
				answer: "Rerun after restart.",
			});
		});
	}, 90_000);
});
