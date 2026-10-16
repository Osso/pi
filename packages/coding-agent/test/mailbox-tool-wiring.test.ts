import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createMultiAgentPiRequestHandler, registerAgentsMailboxTools } from "../extensions/agents-core/src/runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { type AgentMailboxMessage, MultiAgentStore } from "../src/core/multi-agent-store.ts";
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
	const contextRunner = new ExtensionRunner(
		[],
		createExtensionRuntime(),
		"/repo",
		sessionManager,
		ModelRegistry.inMemory(AuthStorage.inMemory()),
	);
	const ctx = { ...contextRunner.createContext(), controlDbPath };
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
	const execute = async (name: string, id: string, params: Record<string, unknown>) => {
		const definition = tool(name);
		const validated = validateToolArguments(definition, fauxToolCall(name, params, { id }));
		return (await definition.execute(id, validated, undefined, undefined, ctx)) as AgentToolResult<{
			message: AgentMailboxMessage;
		}>;
	};
	return { controlDbPath, ctx, execute, sessionManager, spawn, store, tool };
}

describe("model-facing mailbox tool wiring", () => {
	it.each(["send_agent_message", "contact_parent"])(
		"sends explicit %s body through the active-tool bridge without matching assistant identity",
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
					{ body: "  Explicit bridge body\n", ...(name === "send_agent_message" ? { toAgentId: parent.id } : {}) },
					undefined,
					outerId,
				);
				expect(result.isError).not.toBe(true);
				expect(fixture.store.listMailboxMessages().map((message) => message.body)).toEqual([
					"  Explicit bridge body\n",
				]);
				expect(listRuntimeMailboxMessages(fixture.controlDbPath).map((message) => message.body)).toEqual([
					"  Explicit bridge body\n",
				]);
			} finally {
				harness.cleanup();
			}
		},
	);
	it("sends exact body instead of unrelated narration, with routing and attachments", async () => {
		const fixture = createFixture();
		const recipient = fixture.spawn();
		const body = "  Keep all spaces\r\n\tand Unicode: café  ";
		const params = {
			body,
			toAgentId: recipient.id,
			threadId: "thread-1",
			fileRefs: [{ path: "/tmp/report", label: "Report" }],
		};
		fixture.sessionManager.appendMessage(
			fauxAssistantMessage([
				{ type: "text", text: "Unrelated narration" },
				{ type: "thinking", thinking: "Private reasoning must never be sent" },
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
		expect(fixture.store.listMailboxMessages().map((message) => message.body)).toEqual([body]);
		expect(listRuntimeMailboxMessages(fixture.controlDbPath).map((message) => message.body)).toEqual([body]);
	});

	it("sends contact_parent body without normal assistant text", async () => {
		const fixture = createFixture();
		const parent = fixture.spawn();
		const child = fixture.spawn(parent.id);
		fixture.ctx.multiAgentAgentId = child.id;
		const body = "  Parent request\nunchanged  ";
		const params = { body, threadId: "parent-thread", fileRefs: [{ path: "/tmp/question" }] };
		fixture.sessionManager.appendMessage(
			fauxAssistantMessage([
				{ type: "thinking", thinking: "Reasoning is not a mailbox body" },
				fauxToolCall("contact_parent", params, { id: "parent-exact" }),
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
		const args = {
			body: "Explicit body",
			message: "Legacy body",
			...(name === "send_agent_message" ? { toAgentId: "main" } : {}),
		};
		expect(() => validateToolArguments(fixture.tool(name), fauxToolCall(name, args, { id: "legacy" }))).toThrow(
			/Validation failed/,
		);
		expect(fixture.store.listMailboxMessages()).toEqual([]);
	});

	it.each(["send_agent_message", "contact_parent"])("rejects unknown metadata before %s delivery", (name) => {
		const fixture = createFixture();
		const args = {
			body: "Explicit body",
			contentIndex: 0,
			...(name === "send_agent_message" ? { toAgentId: "main" } : {}),
		};
		expect(() => validateToolArguments(fixture.tool(name), fauxToolCall(name, args, { id: "unknown" }))).toThrow(
			/Validation failed/,
		);
	});

	it.each(["send_agent_message", "contact_parent"])("validates required literal %s body", async (name) => {
		const fixture = createFixture();
		const parent = fixture.spawn();
		const child = fixture.spawn(parent.id);
		fixture.ctx.multiAgentAgentId = child.id;
		const routing = name === "send_agent_message" ? { toAgentId: parent.id } : {};
		for (const body of [undefined, "", " \t\r\n"]) {
			const args = body === undefined ? routing : { ...routing, body };
			await expect(fixture.execute(name, "invalid-body", args)).rejects.toThrow(/Validation failed/);
		}
		expect(fixture.store.listMailboxMessages()).toEqual([]);
		expect(listRuntimeMailboxMessages(fixture.controlDbPath)).toEqual([]);
	});

	it.each(["send_agent_message", "contact_parent"])("rejects replaced implicit %s inputs", async (name) => {
		const fixture = createFixture();
		const parent = fixture.spawn();
		const child = fixture.spawn(parent.id);
		fixture.ctx.multiAgentAgentId = child.id;
		const routing = name === "send_agent_message" ? { toAgentId: parent.id } : {};
		fixture.sessionManager.appendMessage(
			fauxAssistantMessage([
				{ type: "text", text: "Old implicit body" },
				fauxToolCall(name, routing, { id: "implicit" }),
			]),
		);
		for (const args of [routing, { ...routing, textIndex: 0 }, { ...routing, body: "Body", textIndex: 0 }]) {
			await expect(fixture.execute(name, "implicit", args)).rejects.toThrow(/Validation failed/);
		}
		expect(fixture.store.listMailboxMessages()).toEqual([]);
		expect(listRuntimeMailboxMessages(fixture.controlDbPath)).toEqual([]);
	});

	it.each(["send_agent_message", "contact_parent"])("sends %s body without any assistant response", async (name) => {
		const fixture = createFixture();
		const parent = fixture.spawn();
		const child = fixture.spawn(parent.id);
		fixture.ctx.multiAgentAgentId = child.id;
		const body = "  No assistant response\r\n";
		const params = { body, ...(name === "send_agent_message" ? { toAgentId: parent.id } : {}) };
		const sent = await fixture.execute(name, "not-in-transcript", params);
		expect(sent.isError).not.toBe(true);
		expect(sent.details.message.body).toBe(body);
		expect(fixture.store.listMailboxMessages().map((message) => message.body)).toEqual([body]);
		expect(listRuntimeMailboxMessages(fixture.controlDbPath).map((message) => message.body)).toEqual([body]);
	});

	it.each(["send_agent_message", "contact_parent"])(
		"delivers distinct bodies for later same-turn %s calls",
		async (name) => {
			const fixture = createFixture();
			const parent = fixture.spawn();
			const child = fixture.spawn(parent.id);
			fixture.ctx.multiAgentAgentId = child.id;
			const bodies = ["  First body\n", "Second body\t", "Third body: café"];
			const calls = bodies.map((body, index) =>
				fauxToolCall(
					name,
					{ body, ...(name === "send_agent_message" ? { toAgentId: parent.id } : {}) },
					{ id: `later-${index}` },
				),
			);
			fixture.sessionManager.appendMessage(
				fauxAssistantMessage([{ type: "text", text: "Narration is unrelated to all three bodies" }, ...calls]),
			);
			for (const call of calls) {
				const sent = await fixture.execute(name, call.id, call.arguments);
				expect(sent.isError).not.toBe(true);
				expect(sent.details.message.body).toBe(call.arguments.body);
			}
			expect(fixture.store.listMailboxMessages().map((message) => message.body)).toEqual(bodies);
			expect(listRuntimeMailboxMessages(fixture.controlDbPath).map((message) => message.body)).toEqual(bodies);
		},
	);

	it("retains sender identity guards with explicit body", async () => {
		const fixture = createFixture();
		fixture.ctx.multiAgentRequiresAgentId = true;
		const params = { body: "Explicit request", toAgentId: "main", toSessionId: "other-session" };
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
		const params = { body: "Explicit request", toAgentId: unrelated.id };
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
