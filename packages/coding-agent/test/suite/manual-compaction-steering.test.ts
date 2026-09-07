import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { createHarness, getUserTexts } from "./harness.ts";

function createGate() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

function completedTurn(text: string) {
	return fauxAssistantMessage([fauxToolCall("end_turn", { reason: text })], { stopReason: "toolUse" });
}

async function startCompactionWithResumedTool() {
	const thinkingStarted = createGate();
	const releaseThinking = createGate();
	const compactionStarted = createGate();
	const releaseCompaction = createGate();
	const toolStarted = createGate();
	const releaseTool = createGate();
	const waitingTool: AgentTool = {
		name: "wait_for_release",
		label: "Wait for release",
		description: "Hold the resumed tool turn until released",
		parameters: Type.Object({}),
		async execute() {
			toolStarted.release();
			await releaseTool.promise;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	const harness = await createHarness({
		tools: [waitingTool],
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("compaction", async (event) => {
					compactionStarted.release();
					await releaseCompaction.promise;
					return {
						compaction: {
							summary: "Earlier work summarized",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					};
				});
			},
		],
	});
	harness.setResponses([
		completedTurn("Earlier work complete"),
		async () => {
			thinkingStarted.release();
			await releaseThinking.promise;
			return completedTurn("Interrupted thinking");
		},
		fauxAssistantMessage(fauxToolCall("wait_for_release", {}), { stopReason: "toolUse" }),
		completedTurn("Steering handled"),
		completedTurn("Late steering handled"),
	]);
	await harness.session.prompt("Earlier work");
	const runningPrompt = harness.session.prompt("Continue the task");
	await thinkingStarted.promise;
	const compacting = harness.session.compact();
	await compactionStarted.promise;
	return {
		harness,
		compacting,
		releaseCompaction,
		toolStarted,
		releaseTool,
		async cleanup() {
			releaseThinking.release();
			releaseCompaction.release();
			releaseTool.release();
			try {
				await Promise.all([runningPrompt, compacting]);
				await harness.session.agent.waitForIdle();
			} finally {
				harness.cleanup();
			}
		},
	};
}

it("ends manual compaction state before the resumed tool turn finishes", async () => {
	const run = await startCompactionWithResumedTool();
	const { session } = run.harness;
	const completionStates: boolean[] = [];
	session.subscribe((event) => {
		if (event.type === "compaction_end") completionStates.push(session.isCompacting);
	});
	try {
		expect(session.isCompacting).toBe(true);
		run.releaseCompaction.release();
		await run.toolStarted.promise;
		expect(session.isStreaming).toBe(true);
		expect(session.isCompacting).toBe(false);
		expect(completionStates).toEqual([false]);
	} finally {
		await run.cleanup();
	}
});

it("accepts ordinary steering during the resumed tool turn after manual compaction", async () => {
	const run = await startCompactionWithResumedTool();
	const { session } = run.harness;
	let steering: Promise<void> | undefined;
	try {
		expect(session.isCompacting).toBe(true);
		run.releaseCompaction.release();
		await run.toolStarted.promise;
		let accepted = false;
		steering = session.prompt("What happened to the other workers?", { streamingBehavior: "steer" }).then(() => {
			accepted = true;
		});
		await expect.poll(() => accepted, { timeout: 1_000 }).toBe(true);
		expect(session.isStreaming).toBe(true);
		expect(session.getSteeringMessages()).toEqual(["What happened to the other workers?"]);
		run.releaseTool.release();
		await run.compacting;
		expect(getUserTexts(run.harness).filter((text) => text === "What happened to the other workers?")).toHaveLength(
			1,
		);
		expect(session.pendingMessageCount).toBe(0);
	} finally {
		await run.cleanup();
		await steering;
	}
});
