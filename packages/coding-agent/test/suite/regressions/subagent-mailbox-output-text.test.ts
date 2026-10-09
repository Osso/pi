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
afterEach(() => {
	for (const harness of harnesses.splice(0).reverse()) harness.cleanup();
});

async function createPair() {
	fixtureId += 1;
	const store = new MultiAgentStore();
	const parent = await createHarness({
		persistedSession: true,
		multiAgentStore: store,
		fauxProvider: { api: `parent-output-text-${fixtureId}`, provider: `parent-output-text-${fixtureId}` },
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
		fauxProvider: { api: `child-output-text-${fixtureId}`, provider: `child-output-text-${fixtureId}` },
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

describe("sub-agent output_text mailbox delivery", () => {
	it.each(["send_agent_message", "contact_parent"])(
		"delivers streamed assistant text verbatim through %s before the next response",
		async (tool) => {
			const { parent, child, controlDbPath, agentId } = await createPair();
			const body = "\n  Focused standalone diagnostic includes the same source.  Two spaces;\ttab; café/Étain.\n";
			const params =
				tool === "send_agent_message" ? { toAgentId: "main", toSessionId: parent.session.sessionId } : {};
			child.setResponses([
				fauxAssistantMessage([{ type: "text", text: body }, fauxToolCall(tool, params)], { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Report delivered" }), { stopReason: "toolUse" }),
			]);

			await child.session.prompt("Report current progress to the parent");
			await parent.session.drainRuntimeCoordination();
			await parent.session.agent.waitForIdle();

			expect(
				listRuntimeMailboxMessages(controlDbPath).filter((message) => message.sender.agentId === agentId),
			).toEqual([]);
			const prompt = getUserTexts(parent).find((text) => text.includes(`- session: ${child.session.sessionId}`));
			expect(prompt).toBe(
				["From:", `- session: ${child.session.sessionId}`, `- agent: ${agentId}`, "", "Message:", body].join("\n"),
			);
		},
	);

	it("rejects a tool-only report instead of copying inherited or previous assistant text", async () => {
		const { child, store, controlDbPath } = await createPair();
		child.sessionManager.appendMessage(fauxAssistantMessage("Previous assistant text must not be sent"));
		child.setResponses([
			fauxAssistantMessage(fauxToolCall("contact_parent", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Missing text rejected" }), { stopReason: "toolUse" }),
		]);

		await child.session.prompt("Attempt report without output_text");

		expect(listRuntimeMailboxMessages(controlDbPath)).toEqual([]);
		expect(store.listMailboxMessages()).toEqual([]);
		expect(child.session.messages).toContainEqual(
			expect.objectContaining({ role: "toolResult", toolName: "contact_parent", isError: true }),
		);
	});
});
