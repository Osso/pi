import { existsSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { getControlDbPath, readRuntimeMailboxListener } from "../../../src/core/session-control-db.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { requireHeadlessAgentSessionId, withHeadlessPi } from "../headless-pi.ts";

function endTurn(text: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })], {
		stopReason: "toolUse",
	});
}

it.each(["attached", "spawned"] as const)(
	"preserves a live %s child's identity and assignment across production /restart",
	async (origin) => {
		await withHeadlessPi(async (agent) => {
			const assignment = `Finish the ${origin} offline restart assignment`;
			const displayName = `${origin} restart child`;
			let savedSession: { sessionId: string; sessionFile: string } | undefined;
			if (origin === "attached") {
				const session = SessionManager.create(agent.paths.workspaceDir, agent.paths.sessionDir);
				session.setMetadataControlDbPath(getControlDbPath(agent.paths.agentDir));
				session.appendMessage({ role: "user", content: "Saved child work before attachment", timestamp: 1 });
				session.appendMessage(fauxAssistantMessage("Saved child checkpoint"));
				const sessionFile = session.getSessionFile();
				if (!sessionFile) throw new Error("Saved child session has no transcript path");
				savedSession = { sessionId: session.getSessionId(), sessionFile };
			}

			expect(await agent.send({ type: "prompt", message: `Start ${displayName}` })).toMatchObject({ success: true });
			const initial = await agent.waitForLlmRequest((request) => request.agentId === null);
			agent.respondToLlmRequest(
				initial.id,
				fauxAssistantMessage(
					savedSession
						? fauxToolCall("attach_session_agent", {
								path: savedSession.sessionFile,
								displayName,
								prompt: assignment,
							})
						: fauxToolCall("spawn_agent", { context: "fresh", displayName, prompt: assignment }),
					{ stopReason: "toolUse" },
				),
			);
			const afterDispatch = await agent.waitForLlmRequest((request) => request.agentId === null);
			expect(afterDispatch.messages.filter((message) => message.role === "toolResult")).toContainEqual(
				expect.objectContaining({ isError: false }),
			);
			const child = await agent.waitForAgent(
				(candidate) => candidate.displayName === displayName && candidate.lifecycle === "running",
			);
			const childSessionId = requireHeadlessAgentSessionId(child);
			const transcript = child.transcript;
			expect(existsSync(transcript?.path ?? "")).toBe(true);
			if (savedSession) {
				expect(transcript).toEqual({ sessionId: savedSession.sessionId, path: savedSession.sessionFile });
			}
			const outstanding = await agent.waitForLlmRequest((request) => request.sessionId === childSessionId);
			expect(outstanding.agentId).toBe(child.id);
			expect(outstanding.userMessages).toContain(assignment);
			// Leave the parent's post-dispatch model request outstanding too, so its
			// interrupted turn continues and exposes the restart notice after exec.
			const controlDbPath = getControlDbPath(agent.paths.agentDir);
			const parentAddress = { sessionId: agent.sessionId, agentId: null };
			const beforeRestart = readRuntimeMailboxListener(controlDbPath, parentAddress);
			expect(beforeRestart?.pid).toBeGreaterThan(0);

			// RPC SIGHUP exits rather than restarting. /restart exercises the production
			// exec-in-place handoff and control-DB child recovery.
			// Exec replaces the process before the command can answer its RPC request.
			void agent.send({ type: "prompt", message: "/restart" }).catch(() => undefined);
			const restoredMain = await agent.waitForLlmRequest(
				(request) =>
					request.agentId === null && JSON.stringify(request.messages).includes("The agent process was restarted"),
			);
			expect(readRuntimeMailboxListener(controlDbPath, parentAddress)?.pid).toBe(beforeRestart?.pid);
			expect(await agent.send({ type: "get_state" })).toMatchObject({
				success: true,
				data: { sessionId: agent.sessionId, sessionFile: agent.sessionFile },
			});
			const recovered = agent.listAgents().find((candidate) => candidate.id === child.id);
			expect(recovered, JSON.stringify(recovered)).toMatchObject({
				id: child.id,
				lifecycle: "running",
				transcript,
			});
			expect(recovered?.parentId).toBe(child.parentId);
			expect(recovered?.error).toBeUndefined();
			const restoredChild = await agent.waitForLlmRequest((request) => request.sessionId === childSessionId);
			expect(restoredChild.agentId).toBe(child.id);
			expect(restoredChild.userMessages).toContain(assignment);
			if (savedSession) expect(restoredChild.userMessages).toContain("Saved child work before attachment");
			agent.respondToLlmRequest(restoredMain.id, endTurn("Parent recovered"));
			await agent.waitForEvent((event) => event.type === "agent_end");

			const completion = `${origin} assignment completed after restart`;
			agent.respondToLlmRequest(restoredChild.id, endTurn(completion));
			const completed = await agent.waitForAgent(
				(candidate) => candidate.id === child.id && candidate.lifecycle === "completed",
			);
			expect(completed.transcript).toEqual(transcript);
			expect(completed.error).toBeUndefined();
			const notification = await agent.waitForLlmRequest(
				(request) => request.agentId === null && request.userMessages.some((text) => text.includes(completion)),
			);
			expect(notification.userMessages.filter((text) => text.includes(completion))).toHaveLength(1);
			agent.respondToLlmRequest(notification.id, endTurn("Completion received once"));
			await agent.waitForEvent((event) => event.type === "agent_end");
			expect(
				agent
					.readSessionEntries(child.id)
					.filter(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "assistant" &&
							entry.message.content.some((part) => part.type === "text" && part.text === completion),
					),
			).toHaveLength(1);
		});
	},
	90_000,
);
