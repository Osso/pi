import { afterEach, describe, expect, it } from "vitest";
import { assistantMsg, userMsg } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("tree summary abort during session_before_tree", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("keeps the session unchanged when the user cancels before an extension summary returns", async () => {
		let releaseHandler: (() => void) | undefined;
		let handlerStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			handlerStarted = resolve;
		});
		const treeEvents: unknown[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async () => {
						handlerStarted?.();
						await new Promise<void>((resolve) => {
							releaseHandler = resolve;
						});
						return { summary: { summary: "Late extension summary" } };
					});
					pi.on("session_tree", (event) => {
						treeEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);

		const targetId = harness.sessionManager.appendMessage(assistantMsg("kept reply"));
		harness.sessionManager.appendMessage(userMsg("abandoned prompt"));
		const currentLeafId = harness.sessionManager.appendMessage(assistantMsg("abandoned reply"));
		const entryCount = harness.sessionManager.getEntries().length;

		const navigation = harness.session.navigateTree(targetId, { summarize: true });
		await started;
		harness.session.abortBranchSummary();
		releaseHandler?.();
		const result = await navigation;

		expect(result).toEqual({ cancelled: true, aborted: true });
		expect(harness.sessionManager.getLeafId()).toBe(currentLeafId);
		expect(harness.sessionManager.getEntries()).toHaveLength(entryCount);
		expect(treeEvents).toEqual([]);
	});
});
