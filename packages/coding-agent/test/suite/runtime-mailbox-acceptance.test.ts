import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it, vi } from "vitest";
import {
	enqueueStoredRuntimeMailboxMessage,
	getControlDbPath,
	readRuntimeMailboxMessage,
	withControlDb,
} from "../../src/core/session-control-db.ts";
import { type HeadlessPi, withHeadlessPi } from "./headless-pi.ts";

function enqueue(agent: HeadlessPi, messageId: string): number {
	return enqueueStoredRuntimeMailboxMessage(getControlDbPath(agent.paths.agentDir), {
		kind: "message",
		recipient: { sessionId: agent.sessionId, agentId: null },
		sender: { sessionId: "acceptance-sender", agentId: null },
		storeRef: { sessionPath: "/sessions/acceptance-sender.jsonl", messageId },
		message: {
			id: messageId,
			kind: "message",
			fromAgentId: "main",
			toAgentId: "main",
			status: "pending",
			body: `Mailbox acceptance ${messageId}`,
			createdAt: new Date().toISOString(),
		},
	});
}

it("recovers a crash after claim before acceptance and delivers exactly once", async () => {
	await withHeadlessPi(async (agent) => {
		await agent.send({ type: "prompt", message: "Initialize persisted recipient" });
		const initial = await agent.waitForLlmRequest();
		agent.respondToLlmRequest(initial.id, fauxAssistantMessage("Initialized"));
		await agent.waitForSessionEntry(null, (entry) => entry.type === "message" && entry.message.role === "assistant");
		const extensionsDir = join(agent.paths.agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		const extension = join(extensionsDir, "hold-mailbox.ts");
		const claimed = join(agent.paths.workspaceDir, "claimed");
		const release = join(agent.paths.workspaceDir, "release");
		writeFileSync(
			extension,
			[
				'import { existsSync, writeFileSync } from "node:fs";',
				"export default function(pi) {",
				'pi.on("runtime_mailbox", async () => {',
				`if (existsSync(${JSON.stringify(release)})) return { handled: false };`,
				`writeFileSync(${JSON.stringify(claimed)}, "claimed");`,
				"await new Promise(() => {}); return { handled: false }; }); }",
			].join("\n"),
		);
		await agent.restart();
		const id = enqueue(agent, "before-accept");
		await vi.waitFor(() => expect(existsSync(claimed)).toBe(true), { timeout: 10_000 });
		expect(readRuntimeMailboxMessage(getControlDbPath(agent.paths.agentDir), id)?.status).toBe("claimed");
		await agent.crash();
		writeFileSync(release, "release");
		await agent.restart();
		// Recovery returns the claim to pending; the existing idle poll is 30 seconds.
		const request = await agent.waitForLlmRequest(
			(item) => item.userMessages.some((text) => text.includes("Mailbox acceptance before-accept")),
			45_000,
		);
		expect(request.userMessages.filter((text) => text.includes("Mailbox acceptance before-accept"))).toHaveLength(1);
		expect(agent.listRuntimeMailboxMessages()).toEqual([]);
		await agent.send({ type: "abort" });
		await agent.restart();
		await agent.send({ type: "prompt", message: "Inspect accepted history" });
		const probe = await agent.waitForLlmRequest();
		expect(probe.userMessages.filter((text) => text.includes("Mailbox acceptance before-accept"))).toHaveLength(1);
		await agent.send({ type: "abort" });
	});
}, 90_000);

it("recovers acceptance before deletion without redelivery", async () => {
	await withHeadlessPi(async (agent) => {
		const dbPath = getControlDbPath(agent.paths.agentDir);
		withControlDb(dbPath, (db) =>
			db.exec(
				"CREATE TRIGGER hold_mailbox_delete BEFORE DELETE ON multi_agent_mailbox_messages BEGIN SELECT RAISE(IGNORE); END",
			),
		);
		const id = enqueue(agent, "after-accept");
		const request = await agent.waitForLlmRequest((item) =>
			item.userMessages.some((text) => text.includes("Mailbox acceptance after-accept")),
		);
		expect(request.userMessages.filter((text) => text.includes("Mailbox acceptance after-accept"))).toHaveLength(1);
		expect(readRuntimeMailboxMessage(dbPath, id)?.status).toBe("claimed");
		expect(
			agent
				.readSessionEntries(null)
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						entry.mailboxStoreRefs?.some(
							(ref) =>
								ref.sessionPath === "/sessions/acceptance-sender.jsonl" && ref.messageId === "after-accept",
						),
				),
		).toBe(true);
		await agent.crash();
		withControlDb(dbPath, (db) => db.exec("DROP TRIGGER hold_mailbox_delete"));
		await agent.restart();
		expect(agent.listRuntimeMailboxMessages()).toEqual([]);
		await agent.send({ type: "prompt", message: "Inspect accepted history" });
		const probe = await agent.waitForLlmRequest();
		expect(probe.userMessages.filter((text) => text.includes("Mailbox acceptance after-accept"))).toHaveLength(1);
		await agent.send({ type: "abort" });
	});
}, 60_000);

it("accepts wait coordination in its tool result and recovers without replay while a detached child stays live", async () => {
	await withHeadlessPi(
		async (agent) => {
			const started = join(agent.paths.workspaceDir, "wait-started");
			const release = join(agent.paths.workspaceDir, "wait-release");
			const code = [
				"from pathlib import Path",
				"import time",
				`Path(${JSON.stringify(started)}).write_text("started")`,
				`while not Path(${JSON.stringify(release)}).exists(): time.sleep(0.05)`,
				'print("wait job complete")',
			].join("\n");
			await agent.send({ type: "prompt", message: "Start a live job and wait for coordination" });
			const initial = await agent.waitForLlmRequest();
			agent.respondToLlmRequest(
				initial.id,
				fauxAssistantMessage(fauxToolCall("pyrun_eval", { code }), { stopReason: "toolUse" }),
			);
			await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 30_000 });
			const child = await agent.waitForAgent(
				(candidate) => candidate.detached === true && candidate.lifecycle === "running",
			);
			const runnerPid = agent.getRunnerPid(child.id);
			await agent.waitForLlmRequest((request) => request.agentId === null);
			// Message-end interception may replace tool details; acceptance identity must survive it.
			writeFileSync(
				join(agent.paths.agentDir, "extensions", "strip-wait-details.ts"),
				[
					'export default function(pi) { pi.on("message_end", (event) => {',
					'if (event.message.role === "toolResult" && event.message.toolName === "wait_agent") return { message: { ...event.message, details: undefined } };',
					"}); }",
				].join("\n"),
			);
			await agent.crash();
			await agent.restart();
			expect(agent.getRunnerPid(child.id)).toBe(runnerPid);
			await agent.send({ type: "prompt", message: "Wait for coordination with this live job" });
			const next = await agent.waitForLlmRequest((request) => request.agentId === null);
			agent.respondToLlmRequest(
				next.id,
				fauxAssistantMessage(fauxToolCall("wait_agent", {}), { stopReason: "toolUse" }),
			);
			await agent.waitForEvent((event) => event.type === "tool_execution_start" && event.toolName === "wait_agent");
			const dbPath = getControlDbPath(agent.paths.agentDir);
			withControlDb(dbPath, (db) =>
				db.exec(
					"CREATE TRIGGER hold_wait_delete BEFORE DELETE ON multi_agent_mailbox_messages BEGIN SELECT RAISE(IGNORE); END",
				),
			);
			const id = enqueue(agent, "wait-accept");
			await agent.waitForLlmRequest(
				(request) =>
					request.agentId === null &&
					request.messages.some(
						(message) =>
							message.role === "toolResult" &&
							JSON.stringify(message.content).includes("Mailbox acceptance wait-accept"),
					),
			);
			expect(readRuntimeMailboxMessage(dbPath, id)?.status).toBe("claimed");
			expect(
				agent
					.readSessionEntries(null)
					.filter(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.mailboxStoreRefs?.some(
								(ref) =>
									ref.sessionPath === "/sessions/acceptance-sender.jsonl" && ref.messageId === "wait-accept",
							),
					),
			).toHaveLength(1);
			await agent.crash();
			withControlDb(dbPath, (db) => db.exec("DROP TRIGGER hold_wait_delete"));
			await agent.restart();
			expect(agent.getRunnerPid(child.id)).toBe(runnerPid);
			expect(agent.listAgents().find((candidate) => candidate.id === child.id)?.lifecycle).toBe("running");
			expect(readRuntimeMailboxMessage(dbPath, id)).toBeUndefined();
			await agent.send({ type: "prompt", message: "Inspect accepted wait history" });
			const probe = await agent.waitForLlmRequest((request) => request.agentId === null);
			expect(probe.userMessages.filter((text) => text.includes("Mailbox acceptance wait-accept"))).toEqual([]);
			expect(
				probe.messages.filter(
					(message) =>
						message.role === "toolResult" &&
						JSON.stringify(message.content).includes("Mailbox acceptance wait-accept"),
				),
			).toHaveLength(1);
			writeFileSync(release, "release");
			await agent.send({ type: "abort" });
			await agent.waitForAgent((candidate) => candidate.id === child.id && candidate.lifecycle === "completed");
		},
		{ autoDetachTools: true },
	);
}, 90_000);

it("deletes normal delivery after durable acceptance before model completion", async () => {
	await withHeadlessPi(async (agent) => {
		enqueue(agent, "normal-accept");
		await agent.waitForLlmRequest((item) =>
			item.userMessages.some((text) => text.includes("Mailbox acceptance normal-accept")),
		);
		expect(agent.listRuntimeMailboxMessages()).toEqual([]);
		expect(
			agent
				.readSessionEntries(null)
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						entry.mailboxStoreRefs?.some(
							(ref) =>
								ref.sessionPath === "/sessions/acceptance-sender.jsonl" && ref.messageId === "normal-accept",
						),
				),
		).toHaveLength(1);
		await agent.send({ type: "abort" });
	});
}, 60_000);
