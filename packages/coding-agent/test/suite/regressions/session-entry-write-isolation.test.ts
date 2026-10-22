import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { exportSessionToHtml } from "../../../src/core/export-html/index.ts";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import type { SessionEntry, SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

function createPayload() {
	return {
		content: [{ type: "text" as const, text: "written" }],
		details: { todos: [{ text: "written", done: false }] },
	};
}

type Payload = ReturnType<typeof createPayload>;
type WriteCase = {
	name: string;
	register: (payload: Payload) => ExtensionFactory;
	tool?: boolean;
};

const writeCases: WriteCase[] = [
	{
		name: "appendEntry",
		register: (payload) => (pi) => {
			pi.on("session_start", () => pi.appendEntry("plan-mode", payload.details));
		},
	},
	{
		name: "sendMessage content and details",
		register: (payload) => (pi) => {
			pi.on("session_start", () => pi.sendMessage({ customType: "plan-mode", display: true, ...payload }));
		},
	},
	{
		name: "sendUserMessage content",
		register: (payload) => (pi) => {
			let sent = false;
			pi.on("before_agent_start", () => {
				if (sent) return;
				sent = true;
				pi.sendUserMessage(payload.content, { deliverAs: "followUp" });
			});
		},
	},
	{
		name: "before_agent_start message",
		register: (payload) => (pi) => {
			pi.on("before_agent_start", () => ({ message: { customType: "plan-mode", display: true, ...payload } }));
		},
	},
	{
		name: "extension tool content and details",
		tool: true,
		register: (payload) => (pi) => {
			pi.registerTool({
				name: "save_plan",
				label: "Save plan",
				description: "Save plan",
				parameters: Type.Object({}),
				async execute() {
					return payload;
				},
			});
		},
	},
	{
		name: "tool_result replacement content and details",
		tool: true,
		register: (payload) => (pi) => {
			pi.registerTool({
				name: "save_plan",
				label: "Save plan",
				description: "Save plan",
				parameters: Type.Object({}),
				async execute() {
					return createPayload();
				},
			});
			pi.on("tool_result", () => payload);
		},
	},
	{
		name: "message_end replacement",
		register: (payload) => (pi) => {
			pi.on("message_end", (event) =>
				event.message.role === "assistant"
					? { message: { ...event.message, content: [...payload.content, ...event.message.content] } }
					: undefined,
			);
		},
	},
];

type SetupWritePath = "custom entry" | "message" | "custom message" | "compaction" | "branch summary";

function appendSetupEntry(sm: SessionManager, path: SetupWritePath, payload: Payload): void {
	const root = sm.appendMessage(fauxAssistantMessage("root"));
	switch (path) {
		case "custom entry":
			sm.appendCustomEntry("plan-mode", payload.details);
			return;
		case "message":
			sm.appendMessage({
				role: "toolResult",
				toolName: "plan",
				toolCallId: "plan",
				isError: false,
				timestamp: 1,
				...payload,
			});
			return;
		case "custom message":
			sm.appendCustomMessageEntry("plan-mode", payload.content, true, payload.details);
			return;
		case "compaction":
			sm.appendCompaction("written", root, 100, payload.details);
			return;
		case "branch summary":
			sm.branchWithSummary(root, "written", payload.details);
	}
}

function finalResponse() {
	return fauxAssistantMessage([fauxToolCall("end_turn", { reason: "done" })], { stopReason: "toolUse" });
}

function mutatePayload(payload: Payload): void {
	payload.content[0].text = "mutated";
	payload.content.push({ type: "text", text: "local only" });
	payload.details.todos[0].done = true;
	payload.details.todos.push({ text: "local only", done: false });
}

async function expectStoredEntries(harness: Harness, expected: SessionEntry[]): Promise<void> {
	expect(harness.sessionManager.getEntries()).toEqual(expected);
	expect(harness.session.extensionRunner.createContext().sessionManager.getEntries()).toEqual(expected);
	const exportPath = await exportSessionToHtml(harness.sessionManager, undefined, {
		outputPath: join(harness.tempDir, "export.html"),
	});
	const encoded = readFileSync(exportPath, "utf8").match(
		/<script id="session-data" type="application\/json">([^<]+)<\/script>/,
	)?.[1];
	if (!encoded) throw new Error("Missing exported session data");
	const exported = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as { entries: SessionEntry[] };
	expect(exported.entries).toEqual(expected);
}

describe("session entry write isolation", () => {
	it.each(writeCases)("copies $name before storing", async ({ register, tool }) => {
		const payload = createPayload();
		const harness = await createHarness({ persistedSession: true, extensionFactories: [register(payload)] });
		try {
			harness.setResponses(
				tool
					? [fauxAssistantMessage(fauxToolCall("save_plan", {}), { stopReason: "toolUse" }), finalResponse()]
					: [finalResponse(), finalResponse()],
			);
			await harness.session.bindExtensions({ mode: "print" });
			await harness.session.prompt("save state");
			const entries = structuredClone(harness.sessionManager.getEntries());
			const messages = structuredClone(harness.session.messages);
			expect(JSON.stringify(entries)).toContain("written");
			mutatePayload(payload);
			expect(payload.details.todos[0].done).toBe(true);
			await expectStoredEntries(harness, entries);
			expect(harness.session.messages).toEqual(messages);
		} finally {
			harness.cleanup();
		}
	});

	it.each(["sendMessage", "sendUserMessage"] as const)("copies replacement-context %s", async (method) => {
		const harness = await createHarness({ persistedSession: true });
		const payload = createPayload();
		try {
			await harness.session.bindExtensions({ mode: "print" });
			const ctx = harness.session.createReplacedSessionContext();
			if (method === "sendMessage") {
				await ctx.sendMessage({ customType: "plan-mode", display: true, ...payload });
				harness.setResponses([finalResponse()]);
				await harness.session.prompt("persist state");
			} else {
				harness.setResponses([finalResponse()]);
				await ctx.sendUserMessage(payload.content);
			}
			const entries = structuredClone(harness.sessionManager.getEntries());
			expect(JSON.stringify(entries)).toContain("written");
			mutatePayload(payload);
			await expectStoredEntries(harness, entries);
		} finally {
			harness.cleanup();
		}
	});

	it.each(["sendUserMessage", "replacement sendUserMessage", "input"] as const)("copies %s images", async (path) => {
		const images = [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }];
		const harness = await createHarness({
			persistedSession: true,
			extensionFactories: [
				(pi) => {
					if (path === "input") pi.on("input", () => ({ action: "transform", text: "written", images }));
					let sent = false;
					if (path === "sendUserMessage")
						pi.on("before_agent_start", () => {
							if (sent) return;
							sent = true;
							pi.sendUserMessage(images, { deliverAs: "followUp" });
						});
				},
			],
		});
		try {
			await harness.session.bindExtensions({ mode: "print" });
			harness.setResponses([finalResponse(), finalResponse()]);
			if (path === "replacement sendUserMessage") {
				await harness.session.createReplacedSessionContext().sendUserMessage(images);
			} else {
				await harness.session.prompt("written");
			}
			const entries = structuredClone(harness.sessionManager.getEntries());
			expect(JSON.stringify(entries)).toContain("aGVsbG8=");
			images[0].data = "bXV0YXRlZA==";
			await expectStoredEntries(harness, entries);
		} finally {
			harness.cleanup();
		}
	});

	it.each(["steer", "followUp", "nextTurn"] as const)(
		"snapshots sendMessage before %s delivery",
		async (deliverAs) => {
			const payload = createPayload();
			const harness = await createHarness({
				persistedSession: true,
				extensionFactories: [
					(pi) => {
						let sent = false;
						pi.on("before_agent_start", () => {
							if (sent) return;
							sent = true;
							pi.sendMessage({ customType: "queued", display: true, ...payload }, { deliverAs });
							mutatePayload(payload);
						});
					},
				],
			});
			try {
				harness.setResponses([finalResponse(), finalResponse()]);
				await harness.session.prompt("written");
				if (deliverAs === "nextTurn") await harness.session.prompt("deliver pending");
				const entry = harness.sessionManager.getEntries().find((entry) => entry.type === "custom_message");
				expect(entry).toMatchObject({ content: createPayload().content, details: createPayload().details });
				await expectStoredEntries(harness, structuredClone(harness.sessionManager.getEntries()));
			} finally {
				harness.cleanup();
			}
		},
	);

	it("copies extension-owned tool execution metadata", async () => {
		const execution = { agentId: "written" };
		const harness = await createHarness({
			persistedSession: true,
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "save_plan",
						label: "Save plan",
						description: "Save plan",
						parameters: Type.Object({}),
						prepareExecution: () => execution,
						async execute() {
							return createPayload();
						},
					});
				},
			],
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("save_plan", {}), { stopReason: "toolUse" }),
				finalResponse(),
			]);
			await harness.session.prompt("written");
			const entries = structuredClone(harness.sessionManager.getEntries());
			expect(JSON.stringify(entries)).toContain('"agentId":"written"');
			execution.agentId = "mutated";
			await expectStoredEntries(harness, entries);
		} finally {
			harness.cleanup();
		}
	});

	it.each(["custom entry", "message", "custom message", "compaction", "branch summary"] as const)(
		"copies setup %s writes",
		async (path) => {
			const payload = createPayload();
			const harness = await createHarness({ persistedSession: true });
			try {
				await harness.session.bindExtensions({
					mode: "print",
					commandContextActions: {
						showApprovalSelector() {},
						showSandboxSelector() {},
						async waitForIdle() {},
						async newSession(options) {
							await options?.setup?.(harness.sessionManager);
							return { cancelled: false };
						},
						async fork() {
							return { cancelled: false };
						},
						async navigateTree() {
							return { cancelled: false };
						},
						async switchSession() {
							return { cancelled: false };
						},
						async reload() {},
						async restart() {},
					},
				});
				await harness.session.extensionRunner.createCommandContext().newSession({
					setup: async (sm) => appendSetupEntry(sm, path, payload),
				});
				const entries = structuredClone(harness.sessionManager.getEntries());
				expect(JSON.stringify(entries)).toContain("written");
				mutatePayload(payload);
				await expectStoredEntries(harness, entries);
			} finally {
				harness.cleanup();
			}
		},
	);

	it("isolates tool update snapshots before the tool mutates them", async () => {
		const payload = createPayload();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "save_plan",
						label: "Save plan",
						description: "Save plan",
						parameters: Type.Object({}),
						async execute(_id, _params, _signal, onUpdate) {
							onUpdate?.(payload);
							mutatePayload(payload);
							return createPayload();
						},
					});
				},
			],
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("save_plan", {}), { stopReason: "toolUse" }),
				finalResponse(),
			]);
			await harness.session.prompt("written");
			const update = harness.eventsOfType("tool_execution_update").find((event) => event.toolName === "save_plan");
			expect(update?.partialResult).toEqual(createPayload());
		} finally {
			harness.cleanup();
		}
	});

	it.each(["compaction", "branch summary"] as const)("copies %s details", async (path) => {
		const payload = createPayload();
		const harness = await createHarness({
			persistedSession: true,
			settings: { compaction: { enabled: false, keepRecentMessages: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("compaction", (event) => ({
						compaction: {
							summary: "written",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: 100,
							details: payload.details,
						},
					}));
					pi.on("session_before_tree", () => ({ summary: { summary: "written", details: payload.details } }));
				},
			],
		});
		try {
			await harness.session.bindExtensions({ mode: "print" });
			const root = harness.sessionManager.appendMessage({ role: "user", content: "root", timestamp: 1 });
			harness.sessionManager.appendMessage(fauxAssistantMessage("first"));
			harness.sessionManager.appendMessage({ role: "user", content: "other", timestamp: 2 });
			harness.sessionManager.appendMessage(fauxAssistantMessage("second"));
			if (path === "compaction") await harness.session.compact();
			else await harness.session.navigateTree(root, { summarize: true });
			const entries = structuredClone(harness.sessionManager.getEntries());
			expect(entries.some((entry) => entry.type === "compaction" || entry.type === "branch_summary")).toBe(true);
			mutatePayload(payload);
			await expectStoredEntries(harness, entries);
		} finally {
			harness.cleanup();
		}
	});
});
