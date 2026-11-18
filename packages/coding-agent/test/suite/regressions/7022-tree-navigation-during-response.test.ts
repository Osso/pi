import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { assistantMsg, userMsg } from "../../utilities.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

// Upstream #7022: navigating the tree while a response streamed moved the leaf under the running turn,
// so the reply was appended to the navigation target's branch instead of the prompt's branch.
describe("issue #7022: tree navigation during a response", () => {
	let harness: Harness | undefined;

	afterEach(() => harness?.cleanup());

	const branchTexts = (h: Harness) =>
		h.sessionManager
			.getBranch()
			.flatMap((entry) => (entry.type === "message" ? [getMessageText(entry.message)] : []))
			.filter(Boolean);

	it("rejects navigation while a response streams and keeps the reply on the prompt's branch", async () => {
		harness = await createHarness();
		harness.sessionManager.appendMessage(userMsg("first user"));
		const targetId = harness.sessionManager.appendMessage(assistantMsg("first assistant"));
		harness.sessionManager.appendMessage(userMsg("second user"));
		harness.sessionManager.appendMessage(assistantMsg("second assistant"));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		let markStreaming!: () => void;
		const streaming = new Promise<void>((resolve) => {
			markStreaming = resolve;
		});
		let releaseReply!: () => void;
		const replyReleased = new Promise<void>((resolve) => {
			releaseReply = resolve;
		});
		harness.setResponses([
			async () => {
				markStreaming();
				await replyReleased;
				return fauxAssistantMessage("probe reply");
			},
		]);

		const prompt = harness.session.prompt("PROBE-7022");
		await streaming;
		await expect(harness.session.navigateTree(targetId, { summarize: false })).rejects.toThrow(
			"Wait for the current response to finish before navigating the session tree.",
		);
		releaseReply();
		await prompt;

		expect(branchTexts(harness)).toEqual([
			"first user",
			"first assistant",
			"second user",
			"second assistant",
			"PROBE-7022",
			"probe reply",
		]);
	});
});
