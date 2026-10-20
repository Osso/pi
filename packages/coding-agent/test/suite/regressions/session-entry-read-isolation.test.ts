import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { collectEntriesForBranchSummary } from "../../../src/core/compaction/branch-summarization.ts";
import { exportSessionToHtml } from "../../../src/core/export-html/index.ts";
import { FooterDataProvider } from "../../../src/core/footer-data-provider.ts";
import type { ReadonlySessionManager, SessionEntry, SessionTreeNode } from "../../../src/core/session-manager.ts";
import { createHarness } from "../harness.ts";

type ReadEntries = (session: ReadonlySessionManager, customId: string) => SessionEntry[];
type Todos = { todos: Array<{ text: string; done: boolean }> };

function treeEntries(nodes: SessionTreeNode[]): SessionEntry[] {
	return nodes.flatMap((node) => [node.entry, ...treeEntries(node.children)]);
}

function readTodos(entry: SessionEntry): Todos | undefined {
	if (entry.type === "custom" && entry.customType === "plan-mode") return entry.data as Todos;
	if (entry.type === "message" && entry.message.role === "toolResult") return entry.message.details as Todos;
	return undefined;
}

const readers: Array<[string, ReadEntries]> = [
	["getEntries", (session) => session.getEntries()],
	["getBranch", (session) => session.getBranch()],
	["getBranch from an entry", (session, id) => session.getBranch(id)],
	["getEntry", (session, id) => [session.getEntry(id)].filter((entry) => entry !== undefined)],
	["getLeafEntry", (session) => [session.getLeafEntry()].filter((entry) => entry !== undefined)],
	["buildContextEntries", (session) => session.buildContextEntries()],
	["getTree", (session) => treeEntries(session.getTree())],
];

describe("session entry read isolation", () => {
	it.each(readers)("keeps %s mutations local to the extension", async (_name, readEntries) => {
		let customId = "";
		const localTodos: Todos[] = [];
		const sameExtensionReads: SessionEntry[][] = [];
		const otherExtensionReads: SessionEntry[][] = [];
		const harness = await createHarness({
			persistedSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						for (const entry of readEntries(ctx.sessionManager, customId)) {
							const todos = readTodos(entry);
							if (!todos) continue;
							todos.todos[0].done = true;
							todos.todos.push({ text: "local only", done: false });
							localTodos.push(todos);
							entry.timestamp = "2000-01-01T00:00:00.000Z";
						}
						sameExtensionReads.push(ctx.sessionManager.getEntries());
					});
				},
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						otherExtensionReads.push(ctx.sessionManager.getBranch());
					});
				},
			],
		});

		try {
			const sm = harness.sessionManager;
			const rootId = sm.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
			sm.appendMessage({
				role: "toolResult",
				toolCallId: "todo-call",
				toolName: "todo",
				content: [{ type: "text", text: "todo saved" }],
				details: { todos: [{ text: "tool todo", done: false }] },
				isError: false,
				timestamp: Date.now(),
			});
			customId = sm.appendCustomEntry("plan-mode", { todos: [{ text: "plan todo", done: false }] });
			const originalEntries = structuredClone(sm.getEntries());
			const seededIds = new Set(originalEntries.map((entry) => entry.id));
			const seededEntries = (entries: SessionEntry[]) => entries.filter((entry) => seededIds.has(entry.id));
			harness.setResponses([fauxAssistantMessage("done")]);

			await harness.session.bindExtensions({ mode: "print" });
			await harness.session.prompt("inspect copies");

			expect(localTodos.length).toBeGreaterThan(0);
			for (const todos of localTodos) {
				expect(todos.todos[0].done).toBe(true);
				expect(todos.todos.at(-1)?.text).toBe("local only");
			}
			expect(sameExtensionReads.map(seededEntries)).toEqual([originalEntries]);
			expect(otherExtensionReads.map(seededEntries)).toEqual([originalEntries]);
			expect(seededEntries(sm.getEntries())).toEqual(originalEntries);
			expect(collectEntriesForBranchSummary(sm, customId, rootId).entries).toEqual(
				originalEntries.filter((entry) => entry.id !== rootId),
			);

			const exportPath = await exportSessionToHtml(sm, undefined, {
				outputPath: join(harness.tempDir, "export.html"),
			});
			const encoded = readFileSync(exportPath, "utf8").match(
				/<script id="session-data" type="application\/json">([^<]+)<\/script>/,
			)?.[1];
			if (!encoded) throw new Error("Missing exported session data");
			const exported = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as { entries: SessionEntry[] };
			expect(seededEntries(exported.entries)).toEqual(originalEntries);
		} finally {
			harness.cleanup();
		}
	});

	it("isolates session reads handed to extensions through footer overrides", async () => {
		let customId = "";
		let localDone: boolean | undefined;
		let laterRead: SessionEntry | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						const session = ctx.footerData?.getSessionOverride()?.sessionManager;
						const entry = session?.getEntry(customId);
						if (!entry) throw new Error("Missing footer session entry");
						const todos = readTodos(entry);
						if (!todos) throw new Error("Missing footer todos");
						todos.todos[0].done = true;
						localDone = todos.todos[0].done;
						laterRead = session?.getEntry(customId);
					});
				},
			],
		});
		const footerData = new FooterDataProvider(harness.tempDir);
		try {
			customId = harness.sessionManager.appendCustomEntry("plan-mode", {
				todos: [{ text: "footer todo", done: false }],
			});
			const original = structuredClone(harness.sessionManager.getEntry(customId));
			footerData.setSessionOverride({
				cwd: harness.tempDir,
				sessionManager: harness.sessionManager,
				model: null,
				thinkingLevel: "off",
				contextUsage: undefined,
			});
			await harness.session.bindExtensions({ mode: "print", footerData });
			harness.setResponses([fauxAssistantMessage("done")]);
			await harness.session.prompt("inspect footer");
			expect(localDone).toBe(true);
			expect(laterRead).toEqual(original);
			expect(harness.sessionManager.getEntry(customId)).toEqual(original);
		} finally {
			footerData.dispose();
			harness.cleanup();
		}
	});

	it("isolates headers and tree structure without freezing extension copies", async () => {
		let observedCwd: string | undefined;
		let mutatedCwd: string | undefined;
		let treeAfterMutation: SessionTreeNode[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						const header = ctx.sessionManager.getHeader();
						if (!header) throw new Error("Missing session header");
						header.cwd = "/extension-local";
						mutatedCwd = header.cwd;
						observedCwd = ctx.sessionManager.getHeader()?.cwd;
						const tree = ctx.sessionManager.getTree();
						tree[0].children.length = 0;
						tree[0].label = "local label";
						treeAfterMutation = ctx.sessionManager.getTree();
					});
				},
			],
		});
		try {
			harness.sessionManager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
			harness.sessionManager.appendCustomEntry("state", { nested: { value: "original" } });
			const originalHeader = structuredClone(harness.sessionManager.getHeader());
			const originalTree = structuredClone(harness.sessionManager.getTree());
			const originalIds = new Set(treeEntries(originalTree).map((entry) => entry.id));
			harness.setResponses([fauxAssistantMessage("done")]);
			await harness.session.bindExtensions({ mode: "print" });
			await harness.session.prompt("inspect tree");
			expect(mutatedCwd).toBe("/extension-local");
			expect(observedCwd).toBe(originalHeader?.cwd);
			expect(harness.sessionManager.getHeader()).toEqual(originalHeader);
			expect(treeEntries(treeAfterMutation).filter((entry) => originalIds.has(entry.id))).toEqual(
				treeEntries(originalTree),
			);
			expect(treeAfterMutation[0].label).toBe(originalTree[0].label);
		} finally {
			harness.cleanup();
		}
	});
});
