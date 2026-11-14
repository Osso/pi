import { type AssistantMessage, type Context, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { writeCompactedSessionFixture } from "./compacted-session-fixture.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

/**
 * Faux-provider coverage for AgentSession.navigateTree. The scenarios mirror
 * agent-session-tree-navigation.test.ts, which only runs with a real API key.
 */
describe("AgentSession tree navigation", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(): Promise<Harness> {
		const harness = await createHarness();
		harness.session.setActiveToolsByName([]);
		harnesses.push(harness);
		return harness;
	}

	async function converse(harness: Harness, prompts: string[]): Promise<void> {
		for (const prompt of prompts) {
			harness.appendResponses([fauxAssistantMessage(`reply to ${prompt}`)]);
			await harness.session.prompt(prompt);
		}
	}

	function messagesWithRole(harness: Harness, role: "user" | "assistant"): SessionEntry[] {
		return harness.sessionManager.getEntries().filter((e) => e.type === "message" && e.message.role === role);
	}

	function requireEntry(entry: SessionEntry | undefined): SessionEntry {
		if (!entry) throw new Error("expected entry");
		return entry;
	}

	function lastUserText(context: Context): string {
		const users = context.messages.filter((message) => message.role === "user");
		const content = users[users.length - 1]?.content;
		if (typeof content === "string") return content;
		return (content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
	}

	it("navigates to the root user message and returns its text for the editor", async () => {
		const harness = await setup();
		await converse(harness, ["First message", "Second message"]);
		const first = requireEntry(messagesWithRole(harness, "user")[0]);

		const result = await harness.session.navigateTree(first.id, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("First message");
		// The leaf moves to the user message's parent, so the message can be edited and resent.
		expect(harness.sessionManager.getLeafId()).toBe(first.parentId);
	});

	it.each([false, true])(
		"navigates before the first retained user message after reopening (summarize: %s)",
		async (summarize) => {
			const harness = await createHarness({ persistedSession: true });
			harnesses.push(harness);
			const filePath = harness.sessionManager.getSessionFile();
			if (!filePath) throw new Error("Expected persisted session");
			writeCompactedSessionFixture(filePath, harness.tempDir, harness.getModel());
			harness.sessionManager.setSessionFile(filePath);
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			expect(harness.sessionManager.getEntries().map((entry) => entry.id)).toEqual([
				"kept-user",
				"kept-assistant",
				"compaction",
				"after-user",
				"after-assistant",
			]);
			if (summarize) harness.appendResponses([fauxAssistantMessage("Abandoned branch summary")]);

			const result = await harness.session.navigateTree("kept-user", { summarize });

			expect(result.cancelled).toBe(false);
			expect(result.editorText).toBe("Retained request");
			expect(result.summaryEntry?.parentId ?? harness.sessionManager.getLeafId()).toBe("old-label");
			expect(harness.session.messages.slice(0, 2).map(getMessageText)).toEqual([
				"Original request",
				"Original reply",
			]);
			expect(harness.session.messages.map((message) => message.role)).toEqual(
				summarize ? ["user", "assistant", "branchSummary"] : ["user", "assistant"],
			);
			expect(harness.sessionManager.getLabel("old-user")).toBe("Original");
			expect(harness.sessionManager.getEntry("inactive-user")).toMatchObject({ parentId: "old-assistant" });
		},
	);

	it("navigates to an assistant message without editor text", async () => {
		const harness = await setup();
		await converse(harness, ["Hello"]);
		const assistant = requireEntry(messagesWithRole(harness, "assistant")[0]);

		const result = await harness.session.navigateTree(assistant.id, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBeUndefined();
		expect(harness.sessionManager.getLeafId()).toBe(assistant.id);
	});

	it("creates a branch summary at the parent of the first user message", async () => {
		const harness = await setup();
		await converse(harness, ["What is 2+2?", "What is 3+3?"]);
		const first = requireEntry(messagesWithRole(harness, "user")[0]);
		harness.appendResponses([fauxAssistantMessage("## Goal\nmath questions")]);

		const result = await harness.session.navigateTree(first.id, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("What is 2+2?");
		expect(result.summaryEntry?.type).toBe("branch_summary");
		expect(result.summaryEntry?.summary).toContain("math questions");
		expect(result.summaryEntry?.parentId).toBe(first.parentId);
		expect(harness.sessionManager.getLeafId()).toBe(result.summaryEntry?.id);
	});

	it("preserves file operations from entries outside the branch-summary token budget", async () => {
		const harness = await createHarness({
			models: [{ id: "branch-summary", contextWindow: 2000, maxTokens: 1024 }],
			settings: { branchSummary: { reserveTokens: 1000 } },
		});
		harnesses.push(harness);
		const root = harness.sessionManager.appendMessage({ role: "user", content: "Explore files", timestamp: 1 });
		harness.sessionManager.appendMessage(
			fauxAssistantMessage([
				{ type: "toolCall", id: "read-old", name: "read", arguments: { path: "old-read.ts" } },
				{
					type: "toolCall",
					id: "write-old",
					name: "write",
					arguments: { path: "old-write.ts", content: "export const value = 1;" },
				},
			]),
		);
		harness.sessionManager.appendMessage({ role: "user", content: "x".repeat(8000), timestamp: 2 });
		harness.sessionManager.appendMessage(fauxAssistantMessage("Recent reply"));
		let summaryPrompt = "";
		harness.appendResponses([
			(context) => {
				summaryPrompt = lastUserText(context);
				return fauxAssistantMessage("Explored the files.");
			},
		]);

		const result = await harness.session.navigateTree(root, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(result.summaryEntry?.details).toEqual({
			readFiles: ["old-read.ts"],
			modifiedFiles: ["old-write.ts"],
		});
		expect(result.summaryEntry?.summary).toContain("<read-files>\nold-read.ts\n</read-files>");
		expect(result.summaryEntry?.summary).toContain("<modified-files>\nold-write.ts\n</modified-files>");
		expect(summaryPrompt).toContain("Recent reply");
		expect(summaryPrompt).not.toContain("old-read.ts");
		expect(summaryPrompt).not.toContain("x".repeat(8000));
	});

	it("attaches the summary to the parent of a nested user message", async () => {
		const harness = await setup();
		await converse(harness, ["Message one", "Message two", "Message three"]);
		const users = messagesWithRole(harness, "user");
		expect(users).toHaveLength(3);
		const u2 = requireEntry(users[1]);
		const a1Id = u2.parentId;
		if (!a1Id) throw new Error("u2 has no parent");
		harness.appendResponses([fauxAssistantMessage("summary of later turns")]);

		const result = await harness.session.navigateTree(u2.id, { summarize: true });

		expect(result.editorText).toBe("Message two");
		expect(result.summaryEntry?.parentId).toBe(a1Id);
		expect(
			harness.sessionManager
				.getChildren(a1Id)
				.map((child) => child.type)
				.sort(),
		).toEqual(["branch_summary", "message"]);
	});

	it("attaches the summary to a selected assistant message", async () => {
		const harness = await setup();
		await converse(harness, ["Hello", "Goodbye"]);
		const a1 = requireEntry(messagesWithRole(harness, "assistant")[0]);
		harness.appendResponses([fauxAssistantMessage("summary of goodbye")]);

		const result = await harness.session.navigateTree(a1.id, { summarize: true });

		expect(result.editorText).toBeUndefined();
		expect(result.summaryEntry?.parentId).toBe(a1.id);
		expect(harness.sessionManager.getLeafId()).toBe(result.summaryEntry?.id);
	});

	it("leaves the session unchanged when summarization is aborted", async () => {
		const harness = await setup();
		await converse(harness, ["Tell me about something", "Continue"]);
		const entriesBefore = harness.sessionManager.getEntries().length;
		const leafBefore = harness.sessionManager.getLeafId();
		const root = requireEntry(messagesWithRole(harness, "user")[0]);
		let summaryStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			summaryStarted = resolve;
		});
		harness.appendResponses([
			(_context, options) =>
				new Promise<AssistantMessage>((resolve) => {
					summaryStarted();
					options?.signal?.addEventListener("abort", () =>
						resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
					);
				}),
		]);

		const navigation = harness.session.navigateTree(root.id, { summarize: true });
		await started;
		expect(harness.session.isCompacting).toBe(true);
		harness.session.abortBranchSummary();
		const result = await navigation;

		expect(result).toMatchObject({ cancelled: true, aborted: true });
		expect(result.summaryEntry).toBeUndefined();
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.sessionManager.getEntries()).toHaveLength(entriesBefore);
		expect(harness.sessionManager.getLeafId()).toBe(leafBefore);
	});

	it("creates no entries when navigating without summarization", async () => {
		const harness = await setup();
		await converse(harness, ["First", "Second"]);
		const entriesBefore = harness.sessionManager.getEntries().length;

		await harness.session.navigateTree(requireEntry(messagesWithRole(harness, "user")[0]).id, {
			summarize: false,
		});

		expect(harness.sessionManager.getEntries()).toHaveLength(entriesBefore);
		expect(harness.sessionManager.getEntries().filter((e) => e.type === "branch_summary")).toEqual([]);
	});

	it("treats navigation to the current leaf as a no-op", async () => {
		const harness = await setup();
		await converse(harness, ["Hello"]);
		const leaf = harness.sessionManager.getLeafId();
		if (!leaf) throw new Error("no leaf");
		const entriesBefore = harness.sessionManager.getEntries().length;

		const result = await harness.session.navigateTree(leaf, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(harness.sessionManager.getLeafId()).toBe(leaf);
		expect(harness.sessionManager.getEntries()).toHaveLength(entriesBefore);
	});

	it("passes custom summarization instructions to the summary request", async () => {
		const harness = await setup();
		await converse(harness, ["What is TypeScript?"]);
		let summaryPrompt = "";
		harness.appendResponses([
			(context) => {
				summaryPrompt = lastUserText(context);
				return fauxAssistantMessage("summary");
			},
		]);

		await harness.session.navigateTree(requireEntry(messagesWithRole(harness, "user")[0]).id, {
			summarize: true,
			customInstructions: "Focus on MONKEY details",
		});

		expect(summaryPrompt).toContain("Focus on MONKEY details");
	});

	it("summarizes the abandoned branch and sends the target path as context on the next prompt", async () => {
		const harness = await setup();
		await converse(harness, ["Main branch start", "Main branch continue"]);
		const a1 = requireEntry(messagesWithRole(harness, "assistant")[0]);
		const u2 = requireEntry(messagesWithRole(harness, "user")[1]);
		harness.sessionManager.branch(a1.id);
		await converse(harness, ["Branch path"]);
		let summarizedText = "";
		harness.appendResponses([
			(context) => {
				summarizedText = JSON.stringify(context.messages);
				return fauxAssistantMessage("branch explored an alternative");
			},
		]);

		const result = await harness.session.navigateTree(u2.id, { summarize: true });

		expect(result.editorText).toBe("Main branch continue");
		expect(summarizedText).toContain("Branch path");
		expect(summarizedText).not.toContain("Main branch continue");

		let nextContext: Context | undefined;
		harness.appendResponses([
			(context) => {
				nextContext = context;
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("Resumed");
		const sent = JSON.stringify(nextContext?.messages);
		expect(sent).toContain("Main branch start");
		expect(sent).toContain("branch explored an alternative");
		expect(sent).not.toContain("Branch path");
		expect(sent).not.toContain("Main branch continue");
		expect(lastUserText(nextContext as Context)).toBe("Resumed");
	});
});
