import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createMultiAgentPiRequestHandler, registerAgentsMailboxTools } from "../extensions/agents-core/src/runtime.ts";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { MultiAgentStore, type AgentMailboxMessage } from "../src/core/multi-agent-store.ts";
import { getControlDbPath, listRuntimeMailboxMessages } from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { legacyMultiAgentStore } from "./helpers/legacy-multi-agent-store.ts";
import { createHarness } from "./suite/harness.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createFixture() {
	const directory = mkdtempSync(join(tmpdir(), "pi-mailbox-tool-wiring-"));
	directories.push(directory);
	const controlDbPath = getControlDbPath(directory);
	const sessionManager = SessionManager.create("/repo", directory);
	sessionManager.setMetadataControlDbPath(controlDbPath);
	sessionManager.persistForRecovery();
	const store = MultiAgentStore.fromSessionManager(sessionManager);
	const tools = new Map<string, ToolDefinition>();
	const pi = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
	registerAgentsMailboxTools(pi, { store });
	const ctx = {
		controlDbPath,
		cwd: "/repo",
		hasUI: false,
		mode: "print",
		sessionManager,
	} as ExtensionContext;
	const spawn = (parentId?: string) =>
		legacyMultiAgentStore(store).spawnAgent({
			agentType: "test",
			cwd: "/repo",
			displayName: "Mailbox recipient",
			parentId,
			permission: { narrowed: true, policy: "on-request" },
		}).agent;
	const tool = (name: string) => {
		const definition = tools.get(name);
		if (!definition) throw new Error(`Missing tool ${name}`);
		return definition;
	};
	const execute = async (name: string, id: string, params: Record<string, unknown>) =>
		(await tool(name).execute(id, params, undefined, undefined, ctx)) as AgentToolResult<{
			message: AgentMailboxMessage;
		}>;
	return { controlDbPath, ctx, execute, sessionManager, spawn, store, tool };
}

describe("model-facing mailbox tool wiring", () => {
	it.each(["send_agent_message", "contact_parent"])(
		"rejects synthetic %s through the active-tool bridge with an enclosing pyrun_eval identity",
		async (name) => {
			const fixture = createFixture();
			const parent = fixture.spawn();
			const child = fixture.spawn(parent.id);
			const harness = await createHarness({
				persistedSession: true,
				multiAgentAgentId: child.id,
				extensionFactories: [(pi) => registerAgentsMailboxTools(pi, { store: fixture.store })],
			});
			try {
				harness.sessionManager.setMetadataControlDbPath(fixture.controlDbPath);
				await harness.session.bindExtensions({});
				const outerId = "outer-pyrun-call";
				harness.sessionManager.appendMessage(
					fauxAssistantMessage([
						{ type: "text", text: "Outer commentary must never become a mailbox body" },
						fauxToolCall("pyrun_eval", { code: `pi.tools.call("${name}", {})` }, { id: outerId }),
					]),
				);
				const bridgedSession = harness.session as unknown as {
					_callActiveTool(
						toolName: string,
						params: unknown,
						signal: AbortSignal | undefined,
						activeToolCallId: string,
					): Promise<AgentToolResult<unknown>>;
				};
				const result = await bridgedSession._callActiveTool(
					name,
					name === "send_agent_message" ? { toAgentId: parent.id } : {},
					undefined,
					outerId,
				);
				expect(result.isError).toBe(true);
				expect(result.content).toEqual([
					{ type: "text", text: expect.stringMatching(/one assistant response for mailbox tool/) },
				]);
				expect(fixture.store.listMailboxMessages()).toEqual([]);
				expect(listRuntimeMailboxMessages(fixture.controlDbPath)).toEqual([]);
			} finally {
				harness.cleanup();
			}
		},
	);
	it("sends exact executing assistant text unchanged, with routing and attachments", async () => {
		const fixture = createFixture();
		const recipient = fixture.spawn();
		const body = "  Keep all spaces\r\n\tand Unicode: café  ";
		const params = {
			toAgentId: recipient.id,
			threadId: "thread-1",
			fileRefs: [{ path: "/tmp/report", label: "Report" }],
		};
		fixture.sessionManager.appendMessage(
			fauxAssistantMessage([
				{ type: "text", text: body },
				fauxToolCall("send_agent_message", params, { id: "send-exact" }),
			]),
		);
		fixture.sessionManager.appendMessage(fauxAssistantMessage("Later text must not become the body"));

		const sent = await fixture.execute("send_agent_message", "send-exact", params);

		expect(sent.details.message).toMatchObject({
			body,
			fileRefs: params.fileRefs,
			threadId: "thread-1",
			toAgentId: recipient.id,
		});
		expect(fixture.store.listMailboxMessages()[0]?.body).toBe(body);
		expect(listRuntimeMailboxMessages(fixture.controlDbPath)[0]?.body).toBe(body);
	});

	it("uses a filtered text block index for contact_parent", async () => {
		const fixture = createFixture();
		const parent = fixture.spawn();
		const child = fixture.spawn(parent.id);
		fixture.ctx.multiAgentAgentId = child.id;
		const body = "  Parent request\nunchanged  ";
		const params = { textIndex: 1, threadId: "parent-thread", fileRefs: [{ path: "/tmp/question" }] };
		fixture.sessionManager.appendMessage(
			fauxAssistantMessage([
				{ type: "text", text: "Not this block" },
				fauxToolCall("contact_parent", params, { id: "parent-exact" }),
				{ type: "text", text: body },
			]),
		);

		const contacted = await fixture.execute("contact_parent", "parent-exact", params);

		expect(contacted.details.message).toMatchObject({
			body,
			fromAgentId: child.id,
			kind: "parent_request",
			toAgentId: parent.id,
			threadId: "parent-thread",
			fileRefs: params.fileRefs,
		});
		expect(fixture.store.listMailboxMessages()[0]?.body).toBe(body);
	});

	it.each(["send_agent_message", "contact_parent"])("rejects legacy message arguments for %s", (name) => {
		const fixture = createFixture();
		const args = { message: "Legacy body", ...(name === "send_agent_message" ? { toAgentId: "main" } : {}) };
		expect(() => validateToolArguments(fixture.tool(name), fauxToolCall(name, args, { id: "legacy" }))).toThrow(
			/Validation failed/,
		);
		expect(fixture.store.listMailboxMessages()).toEqual([]);
	});

	it.each(["send_agent_message", "contact_parent"])("rejects unknown metadata before %s delivery", (name) => {
		const fixture = createFixture();
		const args = { contentIndex: 0, ...(name === "send_agent_message" ? { toAgentId: "main" } : {}) };
		expect(() => validateToolArguments(fixture.tool(name), fauxToolCall(name, args, { id: "unknown" }))).toThrow(
			/Validation failed/,
		);
	});

	it.each(["send_agent_message", "contact_parent"])("accepts metadata-only %s arguments", (name) => {
		const fixture = createFixture();
		const args = {
			textIndex: 0,
			...(name === "send_agent_message" ? { toAgentId: "main", toSessionId: "other-session" } : {}),
		};
		expect(validateToolArguments(fixture.tool(name), fauxToolCall(name, args, { id: "metadata" }))).toEqual(args);
	});

	it("does not write a mailbox message when executing tool identity is absent", async () => {
		const fixture = createFixture();
		const recipient = fixture.spawn();
		fixture.sessionManager.appendMessage(fauxAssistantMessage("Not an executing tool message"));
		await expect(fixture.execute("send_agent_message", "missing", { toAgentId: recipient.id })).rejects.toThrow();
		expect(fixture.store.listMailboxMessages()).toEqual([]);
	});

	it("retains sender identity guards after selecting assistant text", async () => {
		const fixture = createFixture();
		fixture.ctx.multiAgentRequiresAgentId = true;
		const params = { toAgentId: "main", toSessionId: "other-session" };
		fixture.sessionManager.appendMessage(
			fauxAssistantMessage([
				{ type: "text", text: "Request" },
				fauxToolCall("send_agent_message", params, { id: "guard" }),
			]),
		);
		const sent = await fixture.execute("send_agent_message", "guard", params);
		expect(sent.content).toEqual([
			{
				type: "text",
				text: "Could not send runtime session message to main in session other-session: subagent runtime identity is unavailable.",
			},
		]);
		expect(fixture.store.listMailboxMessages()).toEqual([]);
	});

	it("retains forbidden recipient guards", async () => {
		const fixture = createFixture();
		const parent = fixture.spawn();
		const child = fixture.spawn(parent.id);
		const unrelated = fixture.spawn();
		fixture.ctx.multiAgentAgentId = child.id;
		const params = { toAgentId: unrelated.id };
		fixture.sessionManager.appendMessage(
			fauxAssistantMessage([
				{ type: "text", text: "Request" },
				fauxToolCall("send_agent_message", params, { id: "forbidden" }),
			]),
		);
		const sent = await fixture.execute("send_agent_message", "forbidden", params);
		expect(sent.content).toEqual([
			{ type: "text", text: `Could not send agent message from ${child.id} to ${unrelated.id}: forbidden_target` },
		]);
		expect(fixture.store.listMailboxMessages()).toEqual([]);
	});

	it("keeps programmatic messages.send literal and independent of assistant text", async () => {
		const fixture = createFixture();
		const recipient = fixture.spawn();
		const handler = createMultiAgentPiRequestHandler({ store: fixture.store });
		const body = "  Literal programmatic body\r\n  ";
		try {
			const result = await handler(
				{ method: "messages.send", params: { message: body, toAgentId: recipient.id } },
				fixture.ctx,
				undefined,
				"not-in-transcript",
			);
			expect(result).toMatchObject({ message: { body, toAgentId: recipient.id } });
			expect(fixture.store.listMailboxMessages()[0]?.body).toBe(body);
		} finally {
			handler.dispose();
		}
	});
});
