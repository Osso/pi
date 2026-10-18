import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { getControlDbPath, readSessionMetadata } from "../../src/core/session-control-db.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createChangeWorkingDirectoryToolDefinition } from "../../src/core/tools/change-working-directory.ts";
import { createHarness, getMessageText } from "./harness.ts";
import { requireHeadlessAgentSessionId, withHeadlessPi } from "./headless-pi.ts";

function endTurn(text: string) {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })], {
		stopReason: "toolUse",
	});
}

describe("child working-directory tool", () => {
	it.each([{ multiAgentAgentId: "child-1" }, { multiAgentRequiresAgentId: true }])(
		"rejects indirect calls before scheduling relocation: %j",
		async (identity) => {
			const harness = await createHarness();
			try {
				const ctx = Object.create(harness.session.extensionRunner.createContext()) as ExtensionContext;
				const scheduled: string[] = [];
				Object.defineProperties(ctx, {
					...Object.fromEntries(Object.entries(identity).map(([key, value]) => [key, { value }])),
					relocateAfterToolResult: { value: (_id: string, cwd: string) => scheduled.push(cwd) },
				});
				await expect(
					createChangeWorkingDirectoryToolDefinition().execute(
						"indirect-child-cwd",
						{ path: harness.tempDir },
						undefined,
						undefined,
						ctx,
					),
				).rejects.toThrow("change_working_directory is not available from child agent runtimes");
				expect(scheduled).toEqual([]);
			} finally {
				harness.cleanup();
			}
		},
	);

	it.each([false, true])(
		"preserves main/standalone availability with historical child provenance (standalone=%s)",
		async (noSupervisor) => {
			const harness = await createHarness({ noSupervisor });
			try {
				const ctx = Object.create(harness.session.extensionRunner.createContext()) as ExtensionContext;
				const scheduled: string[] = [];
				const historical = SessionManager.inMemory(harness.tempDir, { isSubagent: true });
				Object.defineProperties(ctx, {
					sessionManager: { value: historical },
					relocateAfterToolResult: { value: (_id: string, cwd: string) => scheduled.push(cwd) },
				});
				expect(ctx.sessionManager.isSubagentSession()).toBe(true);
				expect(harness.session.getActiveToolNames()).toContain("change_working_directory");
				const result = await createChangeWorkingDirectoryToolDefinition().execute(
					"main-cwd",
					{ path: harness.tempDir },
					undefined,
					undefined,
					ctx,
				);
				expect(result.terminate).toBe(true);
				expect(scheduled).toEqual([harness.tempDir]);
			} finally {
				harness.cleanup();
			}
		},
	);

	it.each([
		{ origin: "spawned", restart: false },
		{ origin: "spawned", restart: true },
		{ origin: "attached", restart: false },
		{ origin: "attached", restart: true },
	] as const)(
		"hides cwd relocation and survives a stale call: %j",
		async ({ origin, restart }) => {
			await withHeadlessPi(async (agent) => {
				const assignment = `Complete ${origin} child cwd probe`;
				const controlDbPath = getControlDbPath(agent.paths.agentDir);
				let saved: SessionManager | undefined;
				if (origin === "attached") {
					saved = SessionManager.create(agent.paths.workspaceDir, agent.paths.sessionDir);
					saved.setMetadataControlDbPath(controlDbPath);
					saved.appendMessage({ role: "user", content: "Saved attachment checkpoint", timestamp: 1 });
					saved.appendMessage(fauxAssistantMessage("Checkpoint recorded"));
				}
				await agent.send({ type: "prompt", message: assignment });
				const parent = await agent.waitForLlmRequest((request) => request.agentId === null);
				expect(parent.tools?.map((tool) => tool.name)).toContain("change_working_directory");
				agent.respondToLlmRequest(
					parent.id,
					fauxAssistantMessage(
						saved
							? fauxToolCall("attach_session_agent", {
									path: saved.getSessionFile(),
									displayName: assignment,
									prompt: assignment,
								})
							: fauxToolCall("spawn_agent", { context: "fresh", displayName: assignment, prompt: assignment }),
						{ stopReason: "toolUse" },
					),
				);
				const child = await agent.waitForAgent(
					(candidate) => candidate.displayName === assignment && candidate.lifecycle === "running",
				);
				const childSessionId = requireHeadlessAgentSessionId(child);
				if (saved) expect(childSessionId).toBe(saved.getSessionId());
				let childRequest = await agent.waitForLlmRequest((request) => request.agentId === child.id);
				expect(childRequest.userMessages).toContain(assignment);
				expect.soft(childRequest.tools?.map((tool) => tool.name)).not.toContain("change_working_directory");
				if (restart) {
					await agent.crash();
					await agent.restart();
					childRequest = await agent.waitForLlmRequest((request) => request.sessionId === childSessionId);
					expect(childRequest.userMessages).toContain(assignment);
					expect.soft(childRequest.tools?.map((tool) => tool.name)).not.toContain("change_working_directory");
				}
				const waitingParent = await agent.waitForLlmRequest((request) => request.agentId === null);
				agent.respondToLlmRequest(waitingParent.id, endTurn("Parent awaiting cwd probe"));
				await agent.waitForEvent((event) => event.type === "agent_end");
				agent.respondToLlmRequest(
					childRequest.id,
					fauxAssistantMessage(
						fauxToolCall("change_working_directory", { path: agent.paths.tempDir }, { id: "stale-child-cwd" }),
						{ stopReason: "toolUse" },
					),
				);
				const continued = await agent
					.waitForLlmRequest((request) => request.agentId === child.id, 10_000)
					.catch((error: unknown) => {
						throw new Error(
							`Child failed to continue: ${JSON.stringify(agent.listAgents().find((candidate) => candidate.id === child.id))}`,
							{ cause: error },
						);
					});
				expect(continued.sessionId).toBe(childSessionId);
				const rejected = continued.messages.find(
					(message) => message.role === "toolResult" && message.toolCallId === "stale-child-cwd",
				);
				expect(rejected).toMatchObject({ isError: true });
				expect(getMessageText(rejected)).toMatch(/not found|not available/);
				const transcriptPath = child.transcript?.path;
				if (!transcriptPath) throw new Error("Missing child transcript path");
				expect(readSessionMetadata(controlDbPath, transcriptPath)?.cwd).toBe(child.cwd);
				expect(
					agent
						.readSessionEntries(child.id)
						.some((entry) => entry.type === "custom_message" && entry.customType === "cwd_changed"),
				).toBe(false);
				// A relative write proves the live child still resolves paths from its original cwd.
				const marker = join(agent.paths.workspaceDir, "cwd-probe.txt");
				// Use the real write tool so the probe observes child tool behavior, not only metadata.
				agent.respondToLlmRequest(
					continued.id,
					fauxAssistantMessage(fauxToolCall("write", { path: "cwd-probe.txt", content: childSessionId }), {
						stopReason: "toolUse",
					}),
				);
				const afterWrite = await agent.waitForLlmRequest((request) => request.agentId === child.id);
				expect(afterWrite.messages.filter((message) => message.role === "toolResult").at(-1)).toMatchObject({
					isError: false,
				});
				expect(readFileSync(marker, "utf8")).toBe(childSessionId);
				const completion = `${origin} child completed after stale cwd call`;
				agent.respondToLlmRequest(afterWrite.id, endTurn(completion));
				const terminal = await agent.waitForAgent(
					(candidate) => candidate.id === child.id && candidate.lifecycle === "completed",
				);
				expect(terminal.transcript).toEqual(child.transcript);
				expect(terminal.cwd).toBe(child.cwd);
				expect(terminal.error).toBeUndefined();
				const notification = await agent.waitForLlmRequest(
					(request) => request.agentId === null && request.userMessages.some((text) => text.includes(completion)),
				);
				expect(notification.userMessages.filter((text) => text.includes(completion))).toHaveLength(1);
				agent.respondToLlmRequest(notification.id, endTurn("Child completion received"));
				await agent.waitForEvent((event) => event.type === "agent_end");
			});
		},
		90_000,
	);
});
