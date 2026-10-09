import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../../src/core/settings-manager.ts";
import type { ExtensionFactory } from "../../src/index.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;
// The faux provider counts four characters per token, so this prompt alone exceeds the 200K-token minimum.
const LARGE_CONTEXT_PROMPT = `large context ${"x".repeat(820_000)}`;
const SMALL_CONTEXT_PROMPT = "small context";

interface IdleScenario {
	api: string;
	provider: string;
	settings?: Partial<Settings>;
	tools?: HarnessOptions["tools"];
	extensionFactories?: ExtensionFactory[];
}

const CODEX_SCENARIO = { api: "openai-codex-responses", provider: "openai-codex" };

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Built at request time so the response carries the request-start timestamp, as real providers do. */
function endTurn(text: string): FauxResponseStep {
	return () =>
		fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })], {
			stopReason: "toolUse",
		});
}

async function createIdleHarness(scenario: IdleScenario): Promise<Harness> {
	const harness = await createHarness({
		fauxProvider: { api: scenario.api, provider: scenario.provider },
		models: [{ id: `${scenario.provider}-model`, contextWindow: 2_000_000 }],
		settings: scenario.settings,
		tools: scenario.tools,
		extensionFactories: scenario.extensionFactories,
	});
	harness.setResponses([endTurn("answer"), endTurn("follow-up answer"), fauxAssistantMessage("idle summary")]);
	return harness;
}

/** Two turns: the large one becomes the summarized prefix, the follow-up is kept. */
async function runConversation(harness: Harness, firstPrompt: string): Promise<void> {
	await harness.session.prompt(firstPrompt);
	await harness.session.prompt("follow-up");
}

function countCompactions(harness: Harness): number {
	return harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length;
}

function lastRequestStartedAt(harness: Harness): number {
	const assistant = [...harness.session.messages].reverse().find((message) => message.role === "assistant");
	if (!assistant || assistant.role !== "assistant") throw new Error("No completed assistant request");
	return assistant.timestamp;
}

async function advanceTo(time: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(Math.max(0, time - Date.now()));
}

async function expectIdleCompaction(harness: Harness): Promise<void> {
	await vi.waitFor(() => expect(countCompactions(harness)).toBe(1));
	expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ reason: "idle", aborted: false });
	const summary = harness.session.messages[0];
	expect(summary?.role).toBe("compactionSummary");
	expect(summary?.role === "compactionSummary" && summary.summary).toContain("idle summary");
}

describe("idle prompt-cache compaction", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.useRealTimers();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it.each([
		{ api: "openai-codex-responses", provider: "openai-codex", dueAfterMs: 27 * MINUTE_MS },
		{ api: "claude-bridge", provider: "claude-bridge", dueAfterMs: 54 * MINUTE_MS },
	])(
		"compacts an idle $provider session at 90% of its cache lifetime, once",
		async ({ api, provider, dueAfterMs }) => {
			vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
			const harness = await createIdleHarness({ api, provider });
			harnesses.push(harness);

			await runConversation(harness, LARGE_CONTEXT_PROMPT);
			const dueAt = lastRequestStartedAt(harness) + dueAfterMs;

			await advanceTo(dueAt - SECOND_MS);
			expect(countCompactions(harness)).toBe(0);
			await advanceTo(dueAt + SECOND_MS);
			await expectIdleCompaction(harness);

			await advanceTo(Date.now() + 3 * 60 * MINUTE_MS);
			expect(countCompactions(harness)).toBe(1);
		},
	);

	it("measures the cache lifetime from the latest request, not the first", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
		const harness = await createIdleHarness({ api: "openai-codex-responses", provider: "openai-codex" });
		harnesses.push(harness);
		harness.setResponses([
			endTurn("answer"),
			endTurn("follow-up answer"),
			endTurn("late answer"),
			fauxAssistantMessage("idle summary"),
			fauxAssistantMessage("idle summary"),
		]);

		await runConversation(harness, LARGE_CONTEXT_PROMPT);
		const firstDueAt = lastRequestStartedAt(harness) + 27 * MINUTE_MS;
		await advanceTo(lastRequestStartedAt(harness) + 20 * MINUTE_MS);
		await harness.session.prompt("late prompt refreshes the cache");
		const secondDueAt = lastRequestStartedAt(harness) + 27 * MINUTE_MS;

		await advanceTo(firstDueAt + SECOND_MS);
		expect(countCompactions(harness)).toBe(0);
		await advanceTo(secondDueAt + SECOND_MS);
		await expectIdleCompaction(harness);
	});

	it("waits for a tool running past the deadline, then compacts from the run's latest request", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
		const toolStarted = createDeferred();
		const releaseTool = createDeferred();
		const slowTool: AgentTool = {
			name: "slow_tool",
			label: "Slow Tool",
			description: "Runs until the test releases it",
			parameters: Type.Object({}),
			execute: async () => {
				toolStarted.resolve();
				await releaseTool.promise;
				return { content: [{ type: "text", text: "slow result" }], details: {} };
			},
		};
		const harness = await createIdleHarness({ ...CODEX_SCENARIO, tools: [slowTool] });
		harnesses.push(harness);
		harness.setResponses([
			endTurn("answer"),
			endTurn("follow-up answer"),
			() => fauxAssistantMessage(fauxToolCall("slow_tool", {}), { stopReason: "toolUse" }),
			endTurn("after tool"),
			fauxAssistantMessage("idle summary"),
			fauxAssistantMessage("idle summary"),
		]);

		await runConversation(harness, LARGE_CONTEXT_PROMPT);
		const firstDueAt = lastRequestStartedAt(harness) + 27 * MINUTE_MS;
		await advanceTo(firstDueAt - 5 * MINUTE_MS);
		const run = harness.session.prompt("run the slow tool");
		await toolStarted.promise;

		await advanceTo(firstDueAt + 10 * MINUTE_MS);
		expect(countCompactions(harness)).toBe(0);
		releaseTool.resolve();
		await run;
		const secondDueAt = lastRequestStartedAt(harness) + 27 * MINUTE_MS;
		await advanceTo(secondDueAt - SECOND_MS);
		expect(countCompactions(harness)).toBe(0);
		await advanceTo(secondDueAt + SECOND_MS);
		await expectIdleCompaction(harness);
	});

	it("does not add an idle compaction after a manual compaction spanning the deadline", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
		const manualStarted = createDeferred();
		const releaseManual = createDeferred();
		const blockingCompaction: ExtensionFactory = (pi) => {
			pi.on("compaction", async (event) => {
				manualStarted.resolve();
				await releaseManual.promise;
				return {
					compaction: {
						summary: `${event.reason} summary`,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				};
			});
		};
		const harness = await createIdleHarness({ ...CODEX_SCENARIO, extensionFactories: [blockingCompaction] });
		harnesses.push(harness);

		await runConversation(harness, LARGE_CONTEXT_PROMPT);
		const dueAt = lastRequestStartedAt(harness) + 27 * MINUTE_MS;
		await advanceTo(dueAt - MINUTE_MS);
		const manual = harness.session.compact();
		await manualStarted.promise;
		await advanceTo(dueAt + MINUTE_MS);
		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["manual"]);
		releaseManual.resolve();
		await manual;
		await advanceTo(Date.now() + 3 * 60 * MINUTE_MS);

		expect(countCompactions(harness)).toBe(1);
		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["manual"]);
	});

	it("does not compact after the session switches to a model that did not write the cache", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
		const harness = await createHarness({
			fauxProvider: CODEX_SCENARIO,
			models: [
				{ id: "cache-writer", contextWindow: 2_000_000 },
				{ id: "switched-to", contextWindow: 2_000_000 },
			],
		});
		harnesses.push(harness);
		harness.setResponses([endTurn("answer"), endTurn("follow-up answer"), fauxAssistantMessage("idle summary")]);

		await runConversation(harness, LARGE_CONTEXT_PROMPT);
		const switchedModel = harness.getModel("switched-to");
		if (!switchedModel) throw new Error("Missing switched-to model");
		await harness.session.setModel(switchedModel);
		await advanceTo(lastRequestStartedAt(harness) + 3 * 60 * MINUTE_MS);

		expect(countCompactions(harness)).toBe(0);
	});

	it("does not compact while an agent-level message is still queued", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
		const harness = await createIdleHarness({ api: "openai-codex-responses", provider: "openai-codex" });
		harnesses.push(harness);

		await runConversation(harness, LARGE_CONTEXT_PROMPT);
		harness.session.agent.followUp({ role: "user", content: "queued follow-up", timestamp: Date.now() });
		await advanceTo(lastRequestStartedAt(harness) + 3 * 60 * MINUTE_MS);

		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		expect(countCompactions(harness)).toBe(0);
	});

	it.each([
		{
			name: "context below 200K tokens",
			prompt: SMALL_CONTEXT_PROMPT,
			scenario: { api: "openai-codex-responses", provider: "openai-codex" },
		},
		{
			name: "provider without a known cache lifetime",
			prompt: LARGE_CONTEXT_PROMPT,
			scenario: { api: "faux-unknown-cache", provider: "faux-unknown-cache" },
		},
		{
			name: "idle compaction disabled",
			prompt: LARGE_CONTEXT_PROMPT,
			scenario: {
				api: "openai-codex-responses",
				provider: "openai-codex",
				settings: { compaction: { idle: false } },
			},
		},
		{
			name: "compaction disabled",
			prompt: LARGE_CONTEXT_PROMPT,
			scenario: {
				api: "openai-codex-responses",
				provider: "openai-codex",
				settings: { compaction: { enabled: false } },
			},
		},
	])("does not compact an idle session with $name", async ({ prompt, scenario }) => {
		vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
		const harness = await createIdleHarness(scenario);
		harnesses.push(harness);

		await runConversation(harness, prompt);
		await advanceTo(lastRequestStartedAt(harness) + 3 * 60 * MINUTE_MS);

		expect(countCompactions(harness)).toBe(0);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});
});
