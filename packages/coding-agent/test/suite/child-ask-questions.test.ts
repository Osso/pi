import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import agentsMailboxExtension from "../../extensions/agents-mailbox/src/index.ts";
import { LifecycleCoordinator } from "../../src/core/lifecycle-coordinator.ts";
import { MultiAgentStore } from "../../src/core/multi-agent-store.ts";
import type { ProcessIdentity } from "../../src/core/runtime-process.ts";
import {
	getControlDbPath,
	getRuntimeProcessInstanceId,
	listRuntimeMailboxMessages,
} from "../../src/core/session-control-db.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
let fixtureId = 0;
afterEach(() => {
	for (const harness of harnesses.splice(0).reverse()) harness.cleanup();
});

const QUESTION = "Which database should the worker migrate?";
const askParams = (blocking: boolean) => ({
	blocking,
	questions: [
		{
			question: QUESTION,
			header: "DB",
			options: [{ label: "Postgres", description: "Primary store" }, { label: "SQLite" }],
		},
	],
});

async function createPair() {
	fixtureId += 1;
	const store = new MultiAgentStore();
	const parent = await createHarness({
		persistedSession: true,
		multiAgentStore: store,
		fauxProvider: { api: `parent-ask-${fixtureId}`, provider: `parent-ask-${fixtureId}` },
		extensionFactories: [(pi) => agentsMailboxExtension(pi, { store })],
	});
	harnesses.push(parent);
	parent.sessionManager.persistForRecovery();
	store.setPersistenceSessionManager(parent.sessionManager);
	const controlDbPath = getControlDbPath(parent.tempDir);
	await parent.session.bindExtensions({ controlDbPath });
	const persistence = store.getPersistenceTarget();
	if (!persistence) throw new Error("Expected persisted parent store");
	const coordinator = new LifecycleCoordinator({
		controlDbPath,
		createAgentId: () => store.allocateAgentIdForLifecycleCoordinator(),
		now: () => new Date().toISOString(),
		processIdentity: JSON.parse(getRuntimeProcessInstanceId()) as ProcessIdentity,
		sessionPath: persistence.sessionPath,
	});
	const prepared = coordinator.prepareChild({
		agentType: "worker",
		cwd: parent.tempDir,
		displayName: "Worker",
		permission: { narrowed: true, policy: "on-request" },
	});
	const child = await createHarness({
		persistedSession: true,
		multiAgentStore: store,
		multiAgentRuntimeRole: "child",
		multiAgentAgentId: prepared.id,
		multiAgentParentSessionId: parent.session.sessionId,
		fauxProvider: { api: `child-ask-${fixtureId}`, provider: `child-ask-${fixtureId}` },
		extensionFactories: [(pi) => agentsMailboxExtension(pi, { store })],
	});
	harnesses.push(child);
	child.sessionManager.setMetadataControlDbPath(controlDbPath);
	child.sessionManager.persistForRecovery();
	const committed = coordinator.commitRunningChild(
		{
			...prepared,
			transcript: { path: child.sessionManager.getSessionFile(), sessionId: child.session.sessionId },
		},
		parent.session.sessionId,
	);
	if (!committed.ok) throw new Error(`Child fixture admission failed: ${committed.error}`);
	store.publishLifecycleCoordinatorSnapshot(committed.agent);
	await child.session.bindExtensions({ controlDbPath });
	return { parent, child, controlDbPath, agentId: committed.agent.id };
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function toolResult(harness: Harness, toolName: string) {
	const message = harness.session.messages.find(
		(candidate) => candidate.role === "toolResult" && candidate.toolName === toolName,
	);
	if (message?.role !== "toolResult") throw new Error(`Missing ${toolName} result`);
	return message;
}

function textOf(message: { content: Array<{ type: string; text?: string }> }): string {
	return message.content.map((part) => part.text ?? "").join("");
}

function questionSent(child: Harness): boolean {
	return child.events.some((event) => event.type === "tool_execution_start" && event.toolName === "ask_questions");
}

describe("child ask_questions relay", () => {
	it("blocks the child until the parent answers through answer_question", async () => {
		const { parent, child, controlDbPath, agentId } = await createPair();
		child.setResponses([
			fauxAssistantMessage(fauxToolCall("ask_questions", askParams(true), { id: "ask-1" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Got answer" }), { stopReason: "toolUse" }),
		]);
		parent.setResponses([
			fauxAssistantMessage(
				fauxToolCall("answer_question", { agentId, requestId: "ask-1", answers: { [QUESTION]: "Postgres" } }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Answered" }), { stopReason: "toolUse" }),
		]);

		const childRun = child.session.prompt("Migrate the database");
		await waitFor(() => questionSent(child));
		await parent.session.drainRuntimeCoordination();
		await parent.session.agent.waitForIdle();
		await childRun;

		const question = getUserTexts(parent).find((text) => text.includes("requestId: ask-1"));
		expect(question).toContain(
			`Child agent ${agentId} asks (requestId: ask-1). The child is blocked until you answer.`,
		);
		expect(question).toContain(`1. [DB] ${QUESTION}`);
		expect(question).toContain("   - Postgres — Primary store");
		expect(textOf(toolResult(parent, "answer_question"))).toBe("Answered Worker (request ask-1).");

		const result = toolResult(child, "ask_questions");
		expect(textOf(result)).toBe(`Parent answered questions:\n- ${QUESTION} → Postgres`);
		expect(result.details).toMatchObject({ answers: { [QUESTION]: "Postgres" }, cancelled: false });
		expect(listRuntimeMailboxMessages(controlDbPath)).toEqual([]);
		expect(getUserTexts(child).some((text) => text.includes("ask_questions_answer"))).toBe(false);
	});

	it("delivers a nonblocking child's answer through its inbox", async () => {
		const { parent, child, controlDbPath, agentId } = await createPair();
		child.setResponses([
			fauxAssistantMessage(fauxToolCall("ask_questions", askParams(false), { id: "ask-2" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Queued" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Read answer" }), { stopReason: "toolUse" }),
		]);
		parent.setResponses([
			fauxAssistantMessage(
				fauxToolCall("answer_question", { agentId, requestId: "ask-2", answers: { [QUESTION]: "SQLite" } }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Answered" }), { stopReason: "toolUse" }),
		]);

		await child.session.prompt("Migrate the database");
		expect(textOf(toolResult(child, "ask_questions"))).toBe(
			"Questions sent to parent (request ask-2). Continue independent work; the answer will arrive in your inbox.",
		);
		await parent.session.drainRuntimeCoordination();
		await parent.session.agent.waitForIdle();
		await child.session.drainRuntimeCoordination();
		await child.session.agent.waitForIdle();

		const inbox = getUserTexts(child).find((text) => text.includes("ask_questions_answer"));
		expect(inbox).toContain(
			JSON.stringify({
				type: "ask_questions_answer",
				requestId: "ask-2",
				answers: { [QUESTION]: "SQLite" },
				cancelled: false,
			}),
		);
		expect(listRuntimeMailboxMessages(controlDbPath)).toEqual([]);
	});

	it("stops waiting when the blocked child is aborted", async () => {
		const { child } = await createPair();
		child.setResponses([
			fauxAssistantMessage(fauxToolCall("ask_questions", askParams(true), { id: "ask-3" }), {
				stopReason: "toolUse",
			}),
		]);

		const childRun = child.session.prompt("Migrate the database");
		await waitFor(() => questionSent(child));
		await child.session.abort();
		await childRun;

		const result = toolResult(child, "ask_questions");
		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe("Agent run aborted");
	});

	it("keeps main-runtime ask_questions on the user question path", async () => {
		const { parent, controlDbPath } = await createPair();
		parent.setResponses([
			fauxAssistantMessage(fauxToolCall("ask_questions", askParams(true)), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "No TUI" }), { stopReason: "toolUse" }),
		]);

		await parent.session.prompt("Ask the user");

		const result = toolResult(parent, "ask_questions");
		expect(textOf(result)).toBe("Error: ask_questions requires an interactive TUI session");
		expect(listRuntimeMailboxMessages(controlDbPath)).toEqual([]);
	});

	it("rejects answers from an agent that is not the asker's parent", async () => {
		const { child, controlDbPath, agentId } = await createPair();
		child.setResponses([
			fauxAssistantMessage(
				fauxToolCall("answer_question", { agentId, requestId: "ask-4", answers: { [QUESTION]: "SQLite" } }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Rejected" }), { stopReason: "toolUse" }),
		]);

		await child.session.prompt("Answer yourself");

		const result = toolResult(child, "answer_question");
		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe(`Could not answer ${agentId}: not a direct child of this agent`);
		expect(listRuntimeMailboxMessages(controlDbPath)).toEqual([]);
	});
});
