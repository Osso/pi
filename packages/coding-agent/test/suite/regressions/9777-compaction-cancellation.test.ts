import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

type SessionWithAutoCompaction = { _runAutoCompaction: (reason: "threshold", willRetry: boolean) => Promise<boolean> };

function seedCompactableSession(harness: Harness): void {
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "x".repeat(500) }],
		timestamp: 1,
	});
	const assistant: AssistantMessage = {
		...fauxAssistantMessage("y".repeat(200), { timestamp: 2 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

const runAutoCompaction = (harness: Harness) =>
	(harness.session as unknown as SessionWithAutoCompaction)._runAutoCompaction("threshold", false);

// Upstream #9777: compaction cancellation must be decided by the abort signal. An abort from a compaction_start
// listener was ignored, and an abort during summarization was reported as "Auto-compaction failed".
describe("issue #9777: compaction cancellation", () => {
	let harness: Harness | undefined;

	afterEach(() => harness?.cleanup());

	async function createCompactableHarness(options: Parameters<typeof createHarness>[0] = {}) {
		harness = await createHarness({ ...options, settings: { compaction: { keepRecentMessages: 1 } } });
		seedCompactableSession(harness);
		return harness;
	}

	it("cancels auto-compaction from a compaction_start listener before any request", async () => {
		const harness = await createCompactableHarness();
		let compactingAtStart: boolean | undefined;
		harness.session.subscribe((event) => {
			if (event.type !== "compaction_start") return;
			compactingAtStart = harness.session.isCompacting;
			harness.session.abortCompaction();
		});
		harness.setResponses([fauxAssistantMessage("summary")]);

		await runAutoCompaction(harness);

		expect(compactingAtStart).toBe(true);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: true, errorMessage: undefined });
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("reports an abort during auto-compaction summarization as cancelled, not failed", async () => {
		const harness = await createCompactableHarness();
		harness.setResponses([
			async (_context, options) => {
				setTimeout(() => harness.session.abortCompaction(), 10);
				await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve()));
				return fauxAssistantMessage("", { stopReason: "aborted" });
			},
		]);

		await runAutoCompaction(harness);

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: true, errorMessage: undefined });
	});

	it("reports an extension cancel of manual compaction as cancelled", async () => {
		const harness = await createCompactableHarness({
			extensionFactories: [(pi) => pi.on("session_before_compact", () => ({ cancel: true }))],
		});

		await expect(harness.session.compact()).rejects.toThrow("Compaction cancelled");

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: true, errorMessage: undefined });
	});
});
