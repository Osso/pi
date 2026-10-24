import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { getControlDbPath } from "../../../src/core/session-control-db.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createSqliteDatabase } from "../../../src/core/sqlite.ts";
import { getMessageText } from "../harness.ts";
import { type HeadlessLlmRequest, type HeadlessPi, withHeadlessPi } from "../headless-pi.ts";

const PARENT_REPORT = "Historical parent report: probe complete";
const ASSIGNMENT = "Report the current child investigation before ending";
const DISPLAY_NAME = "Report-required child";

function completedMessage(text: string) {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: "Done" })], {
		stopReason: "toolUse",
	});
}

// Anthropic's signature envelope: field 2 -> field 1 -> field 8 carries the block kind.
function blockSignature(kind: string): string {
	const field = (tag: number, payload: Buffer) => Buffer.concat([Buffer.from([tag, payload.length]), payload]);
	const header = Buffer.concat([Buffer.from([0x08, 0x12, 0x18, 0x02, 0x38, 0x01]), field(0x42, Buffer.from(kind))]);
	return Buffer.concat([Buffer.from([0x08, 0x04]), field(0x12, field(0x0a, header))]).toString("base64");
}

async function spawnInheritedChild(agent: HeadlessPi, savedSessionFile?: string) {
	await agent.send({ type: "set_session_name", name: "Child report requirement regression" });
	await agent.send({ type: "prompt", message: "Record parent report" });
	const seed = await agent.waitForLlmRequest((request) => request.agentId === null);
	agent.respondToLlmRequest(seed.id, completedMessage(PARENT_REPORT));
	await agent.waitForEvent((event) => event.type === "agent_end");
	await agent.send({ type: "prompt", message: "Delegate current investigation" });
	const spawn = await agent.waitForLlmRequest((request) => request.agentId === null);
	agent.respondToLlmRequest(
		spawn.id,
		fauxAssistantMessage(
			savedSessionFile
				? fauxToolCall("attach_session_agent", {
						path: savedSessionFile,
						displayName: DISPLAY_NAME,
						prompt: ASSIGNMENT,
					})
				: fauxToolCall("spawn_agent", { context: "inherit", displayName: DISPLAY_NAME, prompt: ASSIGNMENT }),
			{ stopReason: "toolUse" },
		),
	);
	const child = await agent.waitForAgent((candidate) => candidate.displayName === DISPLAY_NAME);
	const request = await agent.waitForLlmRequest((candidate) => candidate.agentId === child.id);
	expect(request.userMessages).toContain(ASSIGNMENT);
	if (!savedSessionFile) {
		expect(request.messages.filter((message) => message.role === "assistant").map(getMessageText)).toContain(
			PARENT_REPORT,
		);
	}
	const parent = await agent.waitForLlmRequest((candidate) => candidate.agentId === null);
	const parentEnd = fauxToolCall("end_turn", { reason: "Parent awaits current child report" });
	agent.respondToLlmRequest(parent.id, fauxAssistantMessage(parentEnd, { stopReason: "toolUse" }));
	await expectToolResult(agent, null, parentEnd.id, false);
	await agent.waitForEvent((event) => event.type === "agent_end");
	return { child, request };
}

async function expectToolResult(agent: HeadlessPi, agentId: string | null, toolCallId: string, isError: boolean) {
	const entry = await agent.waitForSessionEntry(
		agentId,
		(candidate) =>
			candidate.type === "message" &&
			candidate.message.role === "toolResult" &&
			candidate.message.toolCallId === toolCallId,
	);
	if (entry.type !== "message" || entry.message.role !== "toolResult") throw new Error("Expected tool result");
	expect(entry.message.isError).toBe(isError);
	return entry.message;
}

async function rejectEndTurn(
	agent: HeadlessPi,
	childId: string,
	request: HeadlessLlmRequest,
	content: ReturnType<typeof fauxAssistantMessage>["content"] = [],
) {
	const end = fauxToolCall("end_turn", { reason: "Done without reporting" });
	agent.respondToLlmRequest(request.id, fauxAssistantMessage([...content, end], { stopReason: "toolUse" }));
	const result = await expectToolResult(agent, childId, end.id, true);
	expect(getMessageText(result)).toMatch(/report|parent/i);
	const retry = await agent.waitForLlmRequest(
		(candidate) => candidate.agentId === childId && candidate.id !== request.id,
	);
	expect(agent.listAgents().find((candidate) => candidate.id === childId)?.lifecycle).toBe("running");
	expect(
		agent.listMailboxMessages().filter((message) => message.fromAgentId === childId && message.status !== "failed"),
	).toHaveLength(0);
	return { retry, end };
}

async function finishChild(
	agent: HeadlessPi,
	childId: string,
	request: HeadlessLlmRequest,
	report = "Current child report",
) {
	agent.respondToLlmRequest(request.id, completedMessage(report));
	const terminal = await agent.waitForAgent(
		(candidate) => candidate.id === childId && candidate.lifecycle === "completed",
	);
	expect(terminal.result?.summary).toBe(report);
	return terminal;
}

describe("child report required", () => {
	it("rejects tool-only end_turn despite inherited parent report and requests another child response", async () => {
		await withHeadlessPi(async (agent) => {
			const { child, request } = await spawnInheritedChild(agent);
			const { retry } = await rejectEndTurn(agent, child.id, request);
			expect(retry.sessionId).toBe(child.transcript?.sessionId);
			await finishChild(agent, child.id, retry);
		});
	});

	it.each(["text", "signed public narration"] as const)("accepts a current %s report", async (kind) => {
		await withHeadlessPi(async (agent) => {
			const { child, request } = await spawnInheritedChild(agent);
			const report = `Current child ${kind} report`;
			const end = fauxToolCall("end_turn", { reason: "Report supplied" });
			const content =
				kind === "text"
					? { type: "text" as const, text: report }
					: { type: "thinking" as const, thinking: report, thinkingSignature: blockSignature("narration") };
			agent.respondToLlmRequest(request.id, fauxAssistantMessage([content, end], { stopReason: "toolUse" }));
			await expectToolResult(agent, child.id, end.id, false);
			const terminal = await agent.waitForAgent(
				(candidate) => candidate.id === child.id && candidate.lifecycle === "completed",
			);
			expect(terminal.result?.summary).toBe(report);
		});
	});

	it.each(["private thinking", "whitespace"] as const)("does not treat %s as a report", async (kind) => {
		await withHeadlessPi(async (agent) => {
			const { child, request } = await spawnInheritedChild(agent);
			const content =
				kind === "whitespace"
					? { type: "text" as const, text: " \n\t " }
					: {
							type: "thinking" as const,
							thinking: "Private child findings",
							thinkingSignature: blockSignature("thinking"),
						};
			const { retry } = await rejectEndTurn(agent, child.id, request, [content]);
			await finishChild(agent, child.id, retry);
		});
	});

	it("accepts successful contact_parent without public assistant text", async () => {
		await withHeadlessPi(async (agent) => {
			const { child, request } = await spawnInheritedChild(agent);
			const report = "Explicit child report delivered to parent";
			const contact = fauxToolCall("contact_parent", { body: report });
			agent.respondToLlmRequest(request.id, fauxAssistantMessage(contact, { stopReason: "toolUse" }));
			const sent = await expectToolResult(agent, child.id, contact.id, false);
			expect(sent.details).toMatchObject({ message: { body: report, fromAgentId: child.id } });
			const continuation = await agent.waitForLlmRequest((candidate) => candidate.agentId === child.id);
			const end = fauxToolCall("end_turn", { reason: "Report delivered" });
			agent.respondToLlmRequest(continuation.id, fauxAssistantMessage(end, { stopReason: "toolUse" }));
			await expectToolResult(agent, child.id, end.id, false);
			await agent.waitForAgent((candidate) => candidate.id === child.id && candidate.lifecycle === "completed");
			const notification = await agent.waitForLlmRequest(
				(candidate) => candidate.agentId === null && candidate.userMessages.some((text) => text.includes(report)),
			);
			expect(notification.userMessages.filter((text) => text.includes(report))).toHaveLength(1);
		});
	});

	it("does not count a contact_parent call that fails body validation", async () => {
		await withHeadlessPi(async (agent) => {
			const { child, request } = await spawnInheritedChild(agent);
			const contact = fauxToolCall("contact_parent", { body: " \n\t " });
			agent.respondToLlmRequest(request.id, fauxAssistantMessage(contact, { stopReason: "toolUse" }));
			await expectToolResult(agent, child.id, contact.id, true);
			const continuation = await agent.waitForLlmRequest((candidate) => candidate.agentId === child.id);
			const { retry } = await rejectEndTurn(agent, child.id, continuation);
			await finishChild(agent, child.id, retry);
		});
	});

	it("rejects completion after contact_parent returns a failed transport result without isError", async () => {
		await withHeadlessPi(async (agent) => {
			const { child, request } = await spawnInheritedChild(agent);
			const database = createSqliteDatabase(getControlDbPath(agent.paths.agentDir));
			const childId = child.id.replaceAll("'", "''");
			// Routing updates the canonical mailbox row after contact_parent stores its body.
			database.exec(`CREATE TRIGGER fail_child_report_transport BEFORE UPDATE OF data ON multi_agent_mailbox_messages
				WHEN json_extract(NEW.data, '$.fromAgentId') = '${childId}'
				AND json_extract(NEW.data, '$.senderSessionId') IS NOT NULL
				AND json_extract(OLD.data, '$.senderSessionId') IS NULL
				BEGIN SELECT RAISE(ABORT, 'Injected child report transport failure'); END`);
			try {
				const contact = fauxToolCall("contact_parent", { body: "Undelivered child report" });
				agent.respondToLlmRequest(request.id, fauxAssistantMessage(contact, { stopReason: "toolUse" }));
				const result = await expectToolResult(agent, child.id, contact.id, false);
				expect(result.details).toMatchObject({ message: { status: "failed", body: "Undelivered child report" } });
			} finally {
				database.exec("DROP TRIGGER fail_child_report_transport");
				database.close();
			}
			const continuation = await agent.waitForLlmRequest((candidate) => candidate.agentId === child.id);
			const { retry } = await rejectEndTurn(agent, child.id, continuation);
			await finishChild(agent, child.id, retry);
		});
	});

	it("does not borrow the attached child's own report from an earlier task", async () => {
		await withHeadlessPi(async (agent) => {
			const saved = SessionManager.create(agent.paths.workspaceDir, agent.paths.sessionDir);
			saved.setMetadataControlDbPath(getControlDbPath(agent.paths.agentDir));
			saved.appendMessage({ role: "user", content: "Earlier child task", timestamp: 1 });
			saved.appendMessage(fauxAssistantMessage("Earlier child report must not satisfy the next task"));
			const path = saved.getSessionFile();
			if (!path) throw new Error("Missing saved child transcript");
			const { child, request } = await spawnInheritedChild(agent, path);
			expect(request.messages.filter((message) => message.role === "assistant").map(getMessageText)).toContain(
				"Earlier child report must not satisfy the next task",
			);
			const { retry } = await rejectEndTurn(agent, child.id, request);
			await finishChild(agent, child.id, retry);
		});
	});

	it("recovers a live rejected child across supervisor crash and routes its later completion once", async () => {
		await withHeadlessPi(async (agent) => {
			const { child, request } = await spawnInheritedChild(agent);
			const { end } = await rejectEndTurn(agent, child.id, request);
			const transcript = child.transcript;
			await agent.crash();
			await agent.restart();
			const resumed = await agent.waitForLlmRequest((candidate) => candidate.sessionId === transcript?.sessionId);
			expect(resumed.agentId).toBe(child.id);
			expect(resumed.userMessages).toContain(ASSIGNMENT);
			expect(resumed.messages).toContainEqual(
				expect.objectContaining({ role: "toolResult", toolCallId: end.id, isError: true }),
			);
			expect(agent.listAgents().find((candidate) => candidate.id === child.id)).toMatchObject({
				id: child.id,
				parentId: child.parentId,
				transcript,
				lifecycle: "running",
			});
			const report = "Child report completed after reportless rejection and restart";
			const terminal = await finishChild(agent, child.id, resumed, report);
			expect(terminal.transcript).toEqual(transcript);
			expect(terminal.error).toBeUndefined();
			const notification = await agent.waitForLlmRequest(
				(candidate) => candidate.agentId === null && candidate.userMessages.some((text) => text.includes(report)),
			);
			expect(notification.userMessages.filter((text) => text.includes(report))).toHaveLength(1);
			agent.respondToLlmRequest(notification.id, completedMessage("Completion received once"));
			await agent.waitForEvent((event) => event.type === "agent_end");
			const delivered = agent
				.readSessionEntries(null)
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						getMessageText(entry.message).includes(report),
				);
			expect(delivered).toHaveLength(1);
			const reports = agent
				.readSessionEntries(child.id)
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						getMessageText(entry.message) === report,
				);
			expect(reports).toHaveLength(1);
			expect(
				agent
					.listMailboxMessages()
					.filter((message) => message.fromAgentId === child.id && message.toAgentId === "main"),
			).toHaveLength(0);
		});
	}, 60_000);
});

it("fails an inherited child when length termination has empty content and no current report", async () => {
	await withHeadlessPi(async (agent) => {
		const { child, request } = await spawnInheritedChild(agent);
		agent.respondToLlmRequest(request.id, fauxAssistantMessage([], { stopReason: "length" }));
		const terminal = await agent.waitForAgent(
			(candidate) =>
				candidate.id === child.id && (candidate.lifecycle === "failed" || candidate.lifecycle === "completed"),
		);
		expect(terminal.lifecycle).toBe("failed");
		expect(terminal.error?.message).toMatch(/current.task report|report.*missing|missing.*report/i);
	});
});
