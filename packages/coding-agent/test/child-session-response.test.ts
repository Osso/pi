import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { readCurrentChildAssistantText } from "../extensions/agents-core/src/child-response.ts";
import { bindProductionChildSession } from "../extensions/agents-core/src/child-session.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createChildSessionMutationFixture } from "./helpers/child-session-mutation.ts";

it("excludes inherited text when compaction truncates the model context during a child request", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-child-response-"));
	try {
		const sessionManager = SessionManager.create(directory, directory);
		const parentText = "INHERITED_PARENT_ONLY ".repeat(1400);
		const parentId = sessionManager.appendMessage(fauxAssistantMessage(parentText));
		const child = bindProductionChildSession({
			...createChildSessionMutationFixture(),
			sessionManager,
			bindExtensions: async () => {},
			extensionRunner: { emit: async () => {} },
			get messages() {
				return sessionManager.buildSessionContext().messages;
			},
			async prompt(text) {
				sessionManager.appendCompaction("Compacted parent context", parentId, 20000);
				sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
				sessionManager.appendMessage(
					fauxAssistantMessage(fauxToolCall("end_turn", { reason: "No textual result" }), {
						stopReason: "toolUse",
					}),
				);
			},
		});
		const previousMessages = new Set(child.messages);
		await child.prompt("Perform current child assignment");
		const projectedParent = sessionManager
			.buildSessionContext()
			.messages.find((message) => message.role === "assistant");
		expect(projectedParent?.content).not.toEqual([{ type: "text", text: parentText }]);
		expect(readCurrentChildAssistantText(child.messages, previousMessages)).toBeUndefined();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
