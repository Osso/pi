import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ThinkingContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createChildEndTurnToolDefinition } from "../extensions/agents-core/src/child-report.ts";
import { readCurrentChildAssistantText } from "../extensions/agents-core/src/child-response.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";

type PersistedMessage = Parameters<SessionManager["appendMessage"]>[0];

const narrationFixture = JSON.parse(
	readFileSync(new URL("./fixtures/anthropic-narration.json", import.meta.url), "utf8"),
) as { content: ThinkingContent[] };

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function parentCall(body = "Report: tests pass.", id = "parent-report"): AssistantMessage {
	return assistant([{ type: "toolCall", name: "contact_parent", id, arguments: { body } }]);
}

function parentResult(status = "pending", isError = false, toolCallId = "parent-report"): ToolResultMessage<unknown> {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "contact_parent",
		content: [{ type: "text", text: "Contacted parent." }],
		details: { message: { id: "message-1", status } },
		isError,
		timestamp: 2,
	};
}

const prompt: AgentMessage = { role: "user", content: "Current task", timestamp: 1 };

describe("child end_turn report requirement", () => {
	let directory: string;
	let session: SessionManager;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-child-report-"));
		session = SessionManager.create(directory, directory);
	});

	afterEach(() => rmSync(directory, { recursive: true, force: true }));

	function endTurn(reason = "done") {
		const context = { sessionManager: session } as unknown as ExtensionContext;
		return createChildEndTurnToolDefinition().execute("finish", { reason }, undefined, undefined, context);
	}

	test.each<[string, PersistedMessage[]]>([
		["no user prompt", [assistant([{ type: "text", text: "Inherited parent report" }])]],
		["no report", [prompt]],
		["tool call only", [prompt, parentCall()]],
		["private thinking", [prompt, assistant([narrationFixture.content[0]])]],
		["whitespace text", [prompt, assistant([{ type: "text", text: " \n\t" }])]],
		["previous task text", [prompt, assistant([{ type: "text", text: "Old report" }]), prompt]],
		["previous task parent send", [prompt, parentCall(), parentResult(), prompt]],
		["unlinked result", [prompt, parentResult()]],
		["result linked to an earlier task call", [prompt, parentCall(), prompt, parentResult()]],
		["failed transport without isError", [prompt, parentCall(), parentResult("failed")]],
		["rejected transport", [prompt, parentCall(), parentResult("rejected")]],
		["tool error", [prompt, parentCall(), parentResult("pending", true)]],
		["blank outgoing body", [prompt, parentCall(" \t"), parentResult()]],
		["wrong tool call id", [prompt, parentCall(), parentResult("pending", false, "other-call")]],
		["result before call", [prompt, parentResult(), parentCall()]],
		["unknown transport status", [prompt, parentCall(), parentResult("unknown")]],
		[
			"missing persisted message identity",
			[prompt, parentCall(), { ...parentResult(), details: { message: { id: "", status: "pending" } } }],
		],
	])("rejects %s and permits the child to report and retry", async (_label, messages) => {
		for (const message of messages) session.appendMessage(message);
		await expect(endTurn()).rejects.toThrow("current-task report");
		if (!messages.includes(prompt)) session.appendMessage(prompt);
		session.appendMessage(assistant([{ type: "text", text: "Current report: completed scoped work." }]));
		expect(await endTurn()).toMatchObject({ terminate: true, details: { reason: "done" } });
	});

	test.each(["pending", "claimed", "accepted"])(
		"accepts a successful %s parent report after durable reopen",
		async (status) => {
			for (const message of [prompt, parentCall(), parentResult(status)]) session.appendMessage(message);
			session.persistForRecovery();
			const path = session.getSessionFile();
			if (!path) throw new Error("Expected persisted child transcript");
			session = SessionManager.open(path, directory);
			expect(await endTurn()).toMatchObject({ terminate: true });
		},
	);

	test("accepts signed public narration and preserves core reason validation", async () => {
		session.appendMessage(prompt);
		session.appendMessage(assistant(structuredClone(narrationFixture.content)));
		await expect(endTurn(" \n")).rejects.toThrow("reason must be a non-empty string");
		expect(await endTurn("Reported results")).toMatchObject({
			terminate: true,
			details: { reason: "Reported results" },
		});
	});
});

describe("current child public report extraction", () => {
	test("returns signed public narration unchanged without exposing private thinking", () => {
		const message = assistant(structuredClone(narrationFixture.content));
		expect(readCurrentChildAssistantText([message], new Set())).toBe(narrationFixture.content[1].thinking);
	});

	test("ignores whitespace and returns the earlier nonblank current report unchanged", () => {
		const report = assistant([{ type: "text", text: "  Report: two files changed.\n" }]);
		const whitespace = assistant([{ type: "text", text: " \n\t " }]);
		expect(readCurrentChildAssistantText([report, whitespace], new Set())).toBe("  Report: two files changed.\n");
	});

	test("does not reuse earlier dispatch reports", () => {
		const previous = assistant([{ type: "text", text: "Old report" }]);
		const messages: AgentMessage[] = [previous, assistant([narrationFixture.content[0]])];
		expect(() => readCurrentChildAssistantText(messages, new Set([previous]))).toThrow("current-task report");
	});

	test.each<[string, AgentMessage[]]>([
		["no messages", []],
		["empty stop", [{ ...assistant([]), stopReason: "stop" }]],
		["empty length termination", [{ ...assistant([]), stopReason: "length" }]],
		["private thinking", [assistant([narrationFixture.content[0]])]],
		["whitespace text", [assistant([{ type: "text", text: " \n\t" }])]],
		["unlinked parent result", [parentResult()]],
		["result before call", [parentResult(), parentCall()]],
		["failed parent report", [parentCall(), parentResult("failed")]],
		["blank parent report", [parentCall(" \t"), parentResult()]],
		["wrong parent call id", [parentCall(), parentResult("pending", false, "other-call")]],
	])("rejects terminal completion with %s", (_label, messages) => {
		expect(() => readCurrentChildAssistantText(messages, new Set())).toThrow("current-task report");
	});

	test.each(["pending", "claimed", "accepted"])(
		"permits a linked successful %s parent report without assistant text",
		(status) => {
			expect(readCurrentChildAssistantText([parentCall(), parentResult(status)], new Set())).toBeUndefined();
		},
	);

	test("does not reuse earlier dispatch parent reports", () => {
		const previous = [parentCall(), parentResult()];
		expect(() => readCurrentChildAssistantText([...previous, assistant([])], new Set(previous))).toThrow(
			"current-task report",
		);
	});

	test.each([false, true])("preserves a current provider failure with earlier prose: %s", (withReport) => {
		const report = assistant([{ type: "text", text: "Work started" }]);
		const failure = { ...assistant([]), stopReason: "error" as const, errorMessage: "Provider rejected request" };
		const messages = withReport ? [report, failure] : [failure];
		expect(() => readCurrentChildAssistantText(messages, new Set())).toThrow(/^Provider rejected request$/);
	});
});
