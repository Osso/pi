import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { getControlDbPath } from "../../../src/core/session-control-db.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { withHeadlessPi } from "../headless-pi.ts";

// A session attached without a prompt waits for input with no runtime; close_agent used to
// fail with "runtime ownership unavailable" and leave it active forever.
it("closes a session attached without a prompt", async () => {
	await withHeadlessPi(async (agent) => {
		const session = SessionManager.create(agent.paths.workspaceDir, agent.paths.sessionDir);
		session.setMetadataControlDbPath(getControlDbPath(agent.paths.agentDir));
		session.appendMessage({ role: "user", content: "Saved child work", timestamp: 1 });
		session.appendMessage(fauxAssistantMessage("Saved child checkpoint"));
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Saved child session has no transcript path");
		const displayName = "parked child";

		expect(await agent.send({ type: "prompt", message: "Attach the saved session" })).toMatchObject({
			success: true,
		});
		const initial = await agent.waitForLlmRequest((request) => request.agentId === null);
		agent.respondToLlmRequest(
			initial.id,
			fauxAssistantMessage(fauxToolCall("attach_session_agent", { path: sessionFile, displayName }), {
				stopReason: "toolUse",
			}),
		);
		const parked = await agent.waitForAgent(
			(candidate) => candidate.displayName === displayName && candidate.lifecycle === "waiting_for_input",
		);

		const afterAttach = await agent.waitForLlmRequest((request) => request.agentId === null);
		agent.respondToLlmRequest(
			afterAttach.id,
			fauxAssistantMessage(fauxToolCall("close_agent", { agentId: parked.id, reason: "superseded" }), {
				stopReason: "toolUse",
			}),
		);
		const afterClose = await agent.waitForLlmRequest((request) => request.agentId === null);
		const closeResult = afterClose.messages.filter((message) => message.role === "toolResult").at(-1);
		expect(closeResult).toMatchObject({ isError: false, toolName: "close_agent" });
		expect(JSON.stringify(closeResult?.content)).toContain(`Cancelled ${displayName}.`);
		expect(agent.listAgents().find((candidate) => candidate.id === parked.id)?.lifecycle).toBe("aborted");

		agent.respondToLlmRequest(
			afterClose.id,
			fauxAssistantMessage([{ type: "text", text: "Closed" }, fauxToolCall("end_turn", { reason: "Closed" })], {
				stopReason: "toolUse",
			}),
		);
		await agent.waitForEvent((event) => event.type === "agent_end");
	});
}, 60_000);
