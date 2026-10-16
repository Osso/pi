import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import agentsMailboxExtension from "../../../extensions/agents-mailbox/src/index.ts";
import { LifecycleCoordinator } from "../../../src/core/lifecycle-coordinator.ts";
import { MultiAgentStore } from "../../../src/core/multi-agent-store.ts";
import type { ProcessIdentity } from "../../../src/core/runtime-process.ts";
import {
	getControlDbPath,
	getRuntimeProcessInstanceId,
	listRuntimeMailboxMessages,
} from "../../../src/core/session-control-db.ts";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
let fixtureId = 0;
const outputCases = [
	{ name: "narration", content: [{ type: "text" as const, text: "Unrelated narration must never be delivered" }] },
	{ name: "tool-only", content: [] },
	{
		name: "reasoning-only",
		content: [{ type: "thinking" as const, thinking: "Private reasoning must never be delivered" }],
	},
];
afterEach(() => {
	for (const harness of harnesses.splice(0).reverse()) harness.cleanup();
});

async function createPair() {
	fixtureId += 1;
	const store = new MultiAgentStore();
	const parent = await createHarness({
		persistedSession: true,
		multiAgentStore: store,
		fauxProvider: { api: `parent-explicit-body-${fixtureId}`, provider: `parent-explicit-body-${fixtureId}` },
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
		fauxProvider: { api: `child-explicit-body-${fixtureId}`, provider: `child-explicit-body-${fixtureId}` },
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
	parent.setResponses([
		fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Received report" }), { stopReason: "toolUse" }),
	]);
	return { parent, child, store, controlDbPath, agentId: committed.agent.id };
}

describe("native explicit-body mailbox delivery in real AgentSessions", () => {
	it.each(["send_agent_message", "contact_parent"])(
		"delivers %s bodies independently of text and reasoning",
		async (tool) => {
			for (const output of outputCases) {
				const { parent, child, controlDbPath, agentId } = await createPair();
				const body = `\n  Explicit ${tool}/${output.name}: café/Étain;  two spaces;\ttab; 雪.\n`;
				const params =
					tool === "send_agent_message"
						? { toAgentId: "main", toSessionId: parent.session.sessionId, body }
						: { body };
				const call = fauxToolCall(tool, params);
				const content = [...output.content, call];
				child.setResponses([
					fauxAssistantMessage(content, { stopReason: "toolUse" }),
					fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Report delivered" }), {
						stopReason: "toolUse",
					}),
				]);

				await child.session.prompt("Report current progress to the parent");
				await parent.session.drainRuntimeCoordination();
				await parent.session.agent.waitForIdle();

				expect(child.session.messages).toContainEqual(
					expect.objectContaining({ role: "toolResult", toolName: tool, isError: false }),
				);
				expect(
					listRuntimeMailboxMessages(controlDbPath).filter((message) => message.sender.agentId === agentId),
				).toEqual([]);
				expect(
					getUserTexts(parent).filter((text) => text.includes(`- session: ${child.session.sessionId}`)),
				).toEqual([
					["From:", `- session: ${child.session.sessionId}`, `- agent: ${agentId}`, "", "Message:", body].join(
						"\n",
					),
				]);
			}
		},
	);

	it.each(["send_agent_message", "contact_parent"])(
		"rejects missing %s body despite prior/current text or reasoning",
		async (tool) => {
			for (const output of ["narration", "reasoning-only"]) {
				const { parent, child, store, controlDbPath } = await createPair();
				child.sessionManager.appendMessage(fauxAssistantMessage("Previous assistant text must not be sent"));
				const params =
					tool === "send_agent_message" ? { toAgentId: "main", toSessionId: parent.session.sessionId } : {};
				const call = fauxToolCall(tool, params);
				const content =
					output === "narration"
						? [{ type: "text" as const, text: "Current assistant text must not be sent" }, call]
						: [{ type: "thinking" as const, thinking: "Private reasoning must not be sent" }, call];
				child.setResponses([
					fauxAssistantMessage(content, { stopReason: "toolUse" }),
					fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Missing body rejected" }), {
						stopReason: "toolUse",
					}),
				]);

				await child.session.prompt("Attempt report without body");

				expect(listRuntimeMailboxMessages(controlDbPath)).toEqual([]);
				expect(store.listMailboxMessages()).toEqual([]);
				expect(getUserTexts(parent)).toEqual([]);
				expect(child.session.messages).toContainEqual(
					expect.objectContaining({ role: "toolResult", toolName: tool, isError: true }),
				);
			}
		},
	);
});
