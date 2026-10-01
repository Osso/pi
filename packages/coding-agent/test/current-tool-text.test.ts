import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { readCurrentToolCallText } from "../extensions/agents-core/src/current-tool-text.ts";
import { getControlDbPath } from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createContext() {
	const directory = mkdtempSync(join(tmpdir(), "pi-current-tool-text-"));
	directories.push(directory);
	const sessionManager = SessionManager.create(directory, directory);
	sessionManager.setMetadataControlDbPath(getControlDbPath(directory));
	sessionManager.appendMessage({ role: "user", content: "Current assignment", timestamp: 1 });
	return { sessionManager };
}

const currentCall = () => fauxToolCall("contact_parent", {}, { id: "call_current|fc_current" });

describe("current mailbox output text", () => {
	it.each(["pyrun_eval", "send_agent_message"])(
		"rejects matching call IDs owned by %s instead of contact_parent",
		(name) => {
			const ctx = createContext();
			ctx.sessionManager.appendMessage(
				fauxAssistantMessage([
					{ type: "text", text: "Wrong tool's commentary" },
					fauxToolCall(name, {}, { id: "call_current|fc_current" }),
				]),
			);

			expect(() => readCurrentToolCallText(ctx, "call_current|fc_current", "contact_parent")).toThrow(
				/one assistant response/,
			);
		},
	);
	it("reads exact output text instead of joined argument prose or newer unrelated text", () => {
		const ctx = createContext();
		const text = "\n  Focused standalone diagnostic.  Two spaces;\ttab; café/Étain; 👩🏽‍💻\n";
		ctx.sessionManager.appendMessage(
			fauxAssistantMessage([
				{ type: "thinking", thinking: "Do not send reasoning" },
				{ type: "text", text },
				fauxToolCall(
					"contact_parent",
					{ message: "Focusedstandalone diagnostic" },
					{ id: "call_current|fc_current" },
				),
			]),
		);
		ctx.sessionManager.appendMessage(fauxAssistantMessage("Newer unrelated answer"));

		expect(readCurrentToolCallText(ctx, "call_current|fc_current", "contact_parent")).toBe(text);
	});

	it("does not use inherited or earlier text when the executing response has no text", () => {
		const ctx = createContext();
		ctx.sessionManager.appendMessage(fauxAssistantMessage("Inherited parent text"));
		ctx.sessionManager.appendMessage(fauxAssistantMessage(currentCall()));

		expect(() => readCurrentToolCallText(ctx, "call_current|fc_current", "contact_parent")).toThrow(/output_text/);
	});

	it("rejects unmatched synthetic tool calls without using a previous response", () => {
		const ctx = createContext();
		ctx.sessionManager.appendMessage(fauxAssistantMessage("Previous answer"));

		expect(() => readCurrentToolCallText(ctx, "synthetic_call", "contact_parent")).toThrow(/one assistant response/);
	});

	it("requires an explicit filtered-text index for multiple text blocks", () => {
		const ctx = createContext();
		ctx.sessionManager.appendMessage(
			fauxAssistantMessage([
				{ type: "text", text: "First body" },
				{ type: "thinking", thinking: "Reasoning is not a text block" },
				currentCall(),
				{ type: "text", text: "Second body\n" },
			]),
		);

		expect(() => readCurrentToolCallText(ctx, "call_current|fc_current", "contact_parent")).toThrow(/textIndex/);
		expect(readCurrentToolCallText(ctx, "call_current|fc_current", "contact_parent", 0)).toBe("First body");
		expect(readCurrentToolCallText(ctx, "call_current|fc_current", "contact_parent", 1)).toBe("Second body\n");
	});

	it.each([-1, 2, 0.5])("rejects unavailable text index %s", (index) => {
		const ctx = createContext();
		ctx.sessionManager.appendMessage(fauxAssistantMessage([{ type: "text", text: "Body" }, currentCall()]));

		expect(() => readCurrentToolCallText(ctx, "call_current|fc_current", "contact_parent", index)).toThrow(
			/textIndex/,
		);
	});

	it("rejects an empty selected text block without reusing another block", () => {
		const ctx = createContext();
		ctx.sessionManager.appendMessage(
			fauxAssistantMessage([{ type: "text", text: "Other body" }, { type: "text", text: " \t\n" }, currentCall()]),
		);

		expect(() => readCurrentToolCallText(ctx, "call_current|fc_current", "contact_parent", 1)).toThrow(/output_text/);
	});

	it("rejects multiple responses containing the same tool-call identity", () => {
		const ctx = createContext();
		ctx.sessionManager.appendMessage(fauxAssistantMessage([{ type: "text", text: "First" }, currentCall()]));
		ctx.sessionManager.appendMessage(fauxAssistantMessage([{ type: "text", text: "Second" }, currentCall()]));

		expect(() => readCurrentToolCallText(ctx, "call_current|fc_current", "contact_parent")).toThrow(
			/one assistant response/,
		);
	});
});
