import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { assistantMsg, userMsg } from "../../utilities.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

// Upstream #9154: a prompt sent while tree navigation summarized the old branch ran on that branch, and the
// navigation then moved the leaf away, dropping the exchange from the new context and from the summary.
describe("issue #9154: prompt during tree navigation", () => {
	let harness: Harness | undefined;

	afterEach(() => harness?.cleanup());

	async function createSession(options: Parameters<typeof createHarness>[0] = {}) {
		harness = await createHarness(options);
		harness.sessionManager.appendMessage(userMsg("first user"));
		const targetId = harness.sessionManager.appendMessage(assistantMsg("first assistant"));
		harness.sessionManager.appendMessage(userMsg("second user"));
		harness.sessionManager.appendMessage(assistantMsg("second assistant"));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		return { harness, targetId };
	}

	// Non-empty message texts; the fork's end_turn follow-up adds an empty assistant message.
	const branchTexts = (h: Harness) =>
		h.sessionManager
			.getBranch()
			.flatMap((entry) => (entry.type === "message" ? [getMessageText(entry.message)] : []))
			.filter(Boolean);

	it("runs a prompt sent during branch summarization on the new branch", async () => {
		const { harness, targetId } = await createSession();
		let markSummaryStarted!: () => void;
		const summaryStarted = new Promise<void>((resolve) => {
			markSummaryStarted = resolve;
		});
		let releaseSummary!: () => void;
		const summaryReleased = new Promise<void>((resolve) => {
			releaseSummary = resolve;
		});
		harness.setResponses([
			async () => {
				markSummaryStarted();
				await summaryReleased;
				return fauxAssistantMessage("branch summary");
			},
			fauxAssistantMessage("probe reply"),
		]);

		const navigation = harness.session.navigateTree(targetId, { summarize: true });
		await summaryStarted;
		const prompt = harness.session.prompt("PROBE-9154");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(branchTexts(harness)).not.toContain("PROBE-9154");
		releaseSummary();
		await navigation;
		await prompt;

		expect(branchTexts(harness)).toEqual(["first user", "first assistant", "PROBE-9154", "probe reply"]);
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "branch_summary")).toBe(true);
	});

	it("lets a session_tree handler prompt on the new branch", async () => {
		let prompted: Promise<void> | undefined;
		const { harness, targetId } = await createSession({
			extensionFactories: [
				(pi) => {
					pi.on("session_tree", async (_event, ctx) => {
						prompted = ctx.isIdle() ? harness?.session.prompt("FROM-TREE") : undefined;
						await prompted;
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("tree reply")]);

		await harness.session.navigateTree(targetId, { summarize: false });

		expect(prompted).toBeDefined();
		expect(branchTexts(harness)).toEqual(["first user", "first assistant", "FROM-TREE", "tree reply"]);
	});
});
