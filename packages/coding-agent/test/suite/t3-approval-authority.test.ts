import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { ApprovalPresetName } from "../../src/core/permissions/presets.ts";
import { type HeadlessPi, requireHeadlessAgentSessionId, withHeadlessPi } from "./headless-pi.ts";

const extensionPath = join(import.meta.dirname, "fixtures", "t3-approval-policy.ts");
const cliPath = join(import.meta.dirname, "fixtures", "t3-approvals-cli.ts");
type T3Mode = "approval-required" | "auto-accept-edits" | "full-access";

function t3Options(mode: T3Mode, approvalPreset: ApprovalPresetName) {
	return {
		cliPath,
		approvalPreset,
		env: { T3_PI_MCP_EXTENSION_PATH: extensionPath, T3_PI_RUNTIME_MODE: mode },
	};
}

async function requestWrite(agent: HeadlessPi): Promise<string> {
	const path = join(agent.paths.workspaceDir, "t3-output.txt");
	await agent.send({ type: "prompt", message: "Write through the configured approval policy" });
	const request = await agent.waitForLlmRequest();
	agent.respondToLlmRequest(
		request.id,
		fauxAssistantMessage([fauxToolCall("write", { path, content: "T3 approved output" })], { stopReason: "toolUse" }),
	);
	return path;
}

async function completeTurn(agent: HeadlessPi, requestId: string, confirmEndTurn = false): Promise<void> {
	agent.respondToLlmRequest(
		requestId,
		fauxAssistantMessage([fauxToolCall("end_turn", { reason: "Approval test complete" })], { stopReason: "toolUse" }),
	);
	if (confirmEndTurn) {
		const dialog = await agent.waitForExtensionUiRequest(
			(request) => request.method === "confirm" && request.title === "Allow end_turn?",
		);
		await agent.respondToExtensionUiRequest({ type: "extension_ui_response", id: dialog.id, confirmed: true });
	}
	expect(await agent.waitForEvent((event) => event.type === "agent_settled")).toEqual({
		type: "agent_settled",
		aborted: false,
	});
}

function writeWasDenied(request: Awaited<ReturnType<HeadlessPi["waitForLlmRequest"]>>): void {
	expect(request.messages).toEqual(
		expect.arrayContaining([expect.objectContaining({ role: "toolResult", toolName: "write", isError: true })]),
	);
}

describe("T3 approval authority", () => {
	it.each([true, false])(
		"uses T3's decision under native Auto Approve (approved: %s)",
		async (approved) => {
			await withHeadlessPi(
				async (agent) => {
					const path = await requestWrite(agent);
					const dialog = await agent.waitForExtensionUiRequest(
						(request) => request.method === "confirm" && request.title === "Allow write?",
					);
					expect(existsSync(path)).toBe(false);
					await agent.respondToExtensionUiRequest({
						type: "extension_ui_response",
						id: dialog.id,
						confirmed: approved,
					});
					const next = await agent.waitForLlmRequest();
					if (approved) expect(readFileSync(path, "utf8")).toBe("T3 approved output");
					else {
						expect(existsSync(path)).toBe(false);
						writeWasDenied(next);
					}
					await completeTurn(agent, next.id, true);
				},
				t3Options("approval-required", "auto-approve"),
			);
		},
		60_000,
	);

	it.each(["auto-accept-edits", "full-access"] as const)(
		"lets T3 %s override native Never without an extra prompt",
		async (mode) => {
			await withHeadlessPi(
				async (agent) => {
					const path = await requestWrite(agent);
					const next = await agent.waitForLlmRequest();
					expect(readFileSync(path, "utf8")).toBe("T3 approved output");
					expect(agent.countExtensionUiRequests((request) => request.method === "confirm")).toBe(0);
					await completeTurn(agent, next.id, mode !== "full-access");
				},
				t3Options(mode, "never-ask-deny"),
			);
		},
		60_000,
	);

	it("aborts an unanswered T3 confirmation without executing the tool", async () => {
		await withHeadlessPi(
			async (agent) => {
				const path = await requestWrite(agent);
				await agent.waitForExtensionUiRequest((request) => request.method === "confirm");
				await agent.send({ type: "abort" });
				expect(await agent.waitForEvent((event) => event.type === "agent_settled")).toMatchObject({
					aborted: true,
				});
				expect(existsSync(path)).toBe(false);
			},
			t3Options("approval-required", "auto-approve"),
		);
	}, 60_000);

	it("keeps unconditional capability restrictions above T3 full access", async () => {
		const options = t3Options("full-access", "auto-approve");
		await withHeadlessPi(
			async (agent) => {
				const path = await requestWrite(agent);
				const next = await agent.waitForLlmRequest();
				writeWasDenied(next);
				expect(existsSync(path)).toBe(false);
				expect(agent.countExtensionUiRequests((request) => request.method === "confirm")).toBe(0);
				await completeTurn(agent, next.id);
			},
			{ ...options, env: { ...options.env, PI_T3_TEST_DENY_WRITES: "1" } },
		);
	}, 60_000);

	it("blocks tools when the designated T3 approval extension is not loaded", async () => {
		await withHeadlessPi(
			async (agent) => {
				const path = await requestWrite(agent);
				const next = await agent.waitForLlmRequest();
				writeWasDenied(next);
				expect(JSON.stringify(next.messages)).toContain("approval");
				expect(existsSync(path)).toBe(false);
				await agent.send({ type: "abort" });
				await agent.waitForEvent((event) => event.type === "agent_settled");
			},
			{ env: { T3_PI_MCP_EXTENSION_PATH: extensionPath, T3_PI_RUNTIME_MODE: "full-access" } },
		);
	}, 60_000);

	it("restores T3 approval authority while a child is live and routes completion once", async () => {
		await withHeadlessPi(
			async (agent) => {
				await agent.send({ type: "prompt", message: "Start a child before the T3 session restarts" });
				const initial = await agent.waitForLlmRequest((request) => request.agentId === null);
				agent.respondToLlmRequest(
					initial.id,
					fauxAssistantMessage(
						fauxToolCall("spawn_agent", {
							context: "fresh",
							displayName: "T3 restart child",
							prompt: "Preserve this T3 child assignment",
						}),
						{ stopReason: "toolUse" },
					),
				);
				const spawnDialog = await agent.waitForExtensionUiRequest(
					(request) => request.method === "confirm" && request.title === "Allow spawn_agent?",
				);
				await agent.respondToExtensionUiRequest({
					type: "extension_ui_response",
					id: spawnDialog.id,
					confirmed: true,
				});
				const child = await agent.waitForAgent((candidate) => candidate.displayName === "T3 restart child");
				const childSessionId = requireHeadlessAgentSessionId(child);
				await agent.waitForLlmRequest((request) => request.sessionId === childSessionId);
				await agent.waitForLlmRequest((request) => request.agentId === null);
				// Exec-in-place abandons this RPC response; the restored request below proves restart succeeded.
				// Fixture shutdown rejects the abandoned response waiter after that independent proof.
				void agent.send({ type: "prompt", message: "/restart" }).catch(() => undefined);
				const restoredMain = await agent.waitForLlmRequest(
					(request) =>
						request.agentId === null &&
						JSON.stringify(request.messages).includes("The agent process was restarted"),
				);
				const restoredChild = await agent.waitForLlmRequest((request) => request.sessionId === childSessionId);
				expect(restoredChild.userMessages).toContain("Preserve this T3 child assignment");
				expect(agent.listAgents().find((candidate) => candidate.id === child.id)?.transcript).toEqual(
					child.transcript,
				);
				const path = join(agent.paths.workspaceDir, "after-t3-restart.txt");
				agent.respondToLlmRequest(
					restoredMain.id,
					fauxAssistantMessage(
						fauxToolCall("write", {
							path,
							content: "T3 authority restored",
						}),
						{ stopReason: "toolUse" },
					),
				);
				const writeDialog = await agent.waitForExtensionUiRequest(
					(request) => request.method === "confirm" && request.title === "Allow write?",
				);
				expect(existsSync(path)).toBe(false);
				await agent.respondToExtensionUiRequest({
					type: "extension_ui_response",
					id: writeDialog.id,
					confirmed: true,
				});
				const parentAfterWrite = await agent.waitForLlmRequest((request) => request.agentId === null);
				expect(readFileSync(path, "utf8")).toBe("T3 authority restored");
				await completeTurn(agent, parentAfterWrite.id, true);
				const completion = "T3 child completed after restart";
				agent.respondToLlmRequest(
					restoredChild.id,
					fauxAssistantMessage(
						[{ type: "text", text: completion }, fauxToolCall("end_turn", { reason: completion })],
						{ stopReason: "toolUse" },
					),
				);
				const completed = await agent.waitForAgent(
					(candidate) => candidate.id === child.id && candidate.lifecycle === "completed",
				);
				expect(completed.transcript).toEqual(child.transcript);
				const notification = await agent.waitForLlmRequest(
					(request) => request.agentId === null && request.userMessages.some((text) => text.includes(completion)),
				);
				expect(notification.userMessages.filter((text) => text.includes(completion))).toHaveLength(1);
				await completeTurn(agent, notification.id, true);
			},
			t3Options("approval-required", "auto-approve"),
		);
	}, 90_000);

	it.each(["auto-approve", "never-ask-deny"] as const)(
		"preserves ordinary Pi %s without a T3 launch marker",
		async (approvalPreset) => {
			await withHeadlessPi(
				async (agent) => {
					const path = await requestWrite(agent);
					const next = await agent.waitForLlmRequest();
					if (approvalPreset === "auto-approve") expect(readFileSync(path, "utf8")).toBe("T3 approved output");
					else {
						writeWasDenied(next);
						expect(existsSync(path)).toBe(false);
					}
					expect(agent.countExtensionUiRequests((request) => request.method === "confirm")).toBe(0);
					if (approvalPreset === "auto-approve") await completeTurn(agent, next.id);
					else {
						await agent.send({ type: "abort" });
						expect(await agent.waitForEvent((event) => event.type === "agent_settled")).toMatchObject({
							aborted: true,
						});
					}
				},
				{ approvalPreset },
			);
		},
		60_000,
	);
});
