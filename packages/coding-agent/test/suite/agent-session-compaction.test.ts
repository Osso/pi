import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateTokens, findCutPoint } from "../../src/core/compaction/index.ts";
import type { ExtensionRunner } from "../../src/core/extensions/index.ts";
import type { SessionMessageEntry } from "../../src/core/session-manager.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./harness.ts";

type SessionWithCompactionInternals = {
	_checkCompaction: (assistantMessage: AssistantMessage, postRunCheck?: boolean) => Promise<boolean>;
	_extensionRunner: ExtensionRunner;
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
	_lengthRecoveryAttempted?: boolean;
};

type SessionWithCompactionAbortInternals = SessionWithCompactionInternals & {
	_compactionAbortController?: AbortController;
	_autoCompactionAbortController?: AbortController;
};

function requireSessionInternals(ref: {
	current?: SessionWithCompactionAbortInternals;
}): SessionWithCompactionAbortInternals {
	if (!ref.current) {
		throw new Error("Session internals were not assigned");
	}
	return ref.current;
}

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

function useSummaryStreamFn(harness: Harness, summary: string): () => number {
	let callCount = 0;
	harness.session.agent.streamFn = (model) => {
		callCount++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(summary),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return () => callCount;
}

function createUserEntry(text: string) {
	return {
		type: "message" as const,
		id: `entry-${Math.random().toString(36).slice(2)}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() },
	};
}

function createAssistantEntry(text: string) {
	return {
		type: "message" as const,
		id: `entry-${Math.random().toString(36).slice(2)}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: fauxAssistantMessage(text),
	};
}

/**
 * Response factory that stamps the message at stream time, a few ms after any preceding
 * compaction entry. Preset messages would carry setup-time timestamps (skipped as stale
 * pre-compaction messages), and same-millisecond timestamps trip the stale guard too.
 */
function delayedResponse(
	text: string,
	options: { stopReason?: AssistantMessage["stopReason"] } = {},
): () => Promise<AssistantMessage> {
	return async () => {
		await new Promise((resolve) => setTimeout(resolve, 5));
		return fauxAssistantMessage(text, options);
	};
}

function fauxCompletedTurn(text: string): AssistantMessage {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })], {
		stopReason: "toolUse",
	});
}

function delayedCompletedTurn(text: string): () => Promise<AssistantMessage> {
	return async () => {
		await new Promise((resolve) => setTimeout(resolve, 5));
		return fauxCompletedTurn(text);
	};
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

function expectToolResultsToFollowCalls(messages: readonly AgentMessage[], toolName: string): number {
	const seenToolCallIds = new Set<string>();
	let matchingResultCount = 0;
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") seenToolCallIds.add(block.id);
			}
		} else if (message.role === "toolResult" && message.toolName === toolName) {
			matchingResultCount++;
			expect(seenToolCallIds.has(message.toolCallId)).toBe(true);
		}
	}
	return matchingResultCount;
}

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "older message to compact" }],
		timestamp: now - 3000,
	});
	harness.sessionManager.appendMessage(
		createAssistant(harness, { stopReason: "stop", totalTokens: 100, timestamp: now - 2500 }),
	);
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const assistant = createAssistant(harness, {
		stopReason: "stop",
		totalTokens: 100,
		timestamp: now - 500,
	});
	assistant.content = [{ type: "text", text: "assistant response to compact" }];
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("keeps no more than the last three context messages when the token suffix is larger", () => {
		const entries = [
			createUserEntry("old user"),
			createAssistantEntry("old assistant"),
			createUserEntry("recent user 1"),
			createAssistantEntry("recent assistant 1"),
			createUserEntry("recent user 2"),
			createAssistantEntry("recent assistant 2"),
		];

		const cutPoint = findCutPoint(entries, 0, entries.length, 20_000);

		expect(cutPoint.firstKeptEntryIndex).toBe(3);
	});

	it("keeps the token-bounded suffix when the last three context messages exceed ten thousand tokens", () => {
		const hugeText = "x".repeat(40_000);
		const entries = [
			createUserEntry("old user"),
			createAssistantEntry("old assistant"),
			createUserEntry(hugeText),
			createAssistantEntry(hugeText),
			createUserEntry("latest user"),
		];

		const cutPoint = findCutPoint(entries, 0, entries.length, 20_000);

		expect(cutPoint.firstKeptEntryIndex).toBe(4);
	});

	it("keeps no verbatim suffix when the latest context message exceeds ten thousand tokens", () => {
		const hugeText = "x".repeat(44_000);
		const entries = [createUserEntry("old user"), createAssistantEntry("old assistant"), createUserEntry(hugeText)];

		const cutPoint = findCutPoint(entries, 0, entries.length, 20_000);

		expect(cutPoint.firstKeptEntryIndex).toBe(entries.length);
	});

	it("manually compacts using an extension-provided summary", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const result = await harness.session.compact();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const estimatedTokensAfter = harness.session.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
		const summaryMessage = harness.session.messages[0];
		if (!summaryMessage) throw new Error("Expected compaction summary message");
		const summaryTokens = estimateTokens(summaryMessage);

		expect(result.summary).toBe("summary from extension");
		expect(result.estimatedTokensAfter).toBe(estimatedTokensAfter);
		expect(result.keptFromPreviousContextTokens).toBe(estimatedTokensAfter - summaryTokens);
		expect(compactionEntries).toHaveLength(1);
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
	});

	it("uses an extension compaction result when built-in compaction is disabled", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => ({
						compaction: {
							summary: "disabled local compaction summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "local summary");

		await expect(harness.session.compact()).resolves.toMatchObject({
			summary: "disabled local compaction summary",
		});
		expect(getStreamCallCount()).toBe(0);
	});

	it("does not use local compaction when disabled and no extension result exists", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "local summary");

		await expect(harness.session.compact()).rejects.toThrow(
			"Built-in compaction is disabled; enable compaction or configure a compaction extension",
		);
		expect(getStreamCallCount()).toBe(0);
	});

	it.each([undefined, {}])(
		"does not invoke local compaction when a disabled handler returns %s and surfaces an explicit failure",
		async (handlerResult) => {
			const harness = await createHarness({
				settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
				extensionFactories: [
					(pi) => {
						pi.on("compaction", async () => handlerResult);
					},
				],
			});
			harnesses.push(harness);
			seedCompactableSession(harness);
			const getStreamCallCount = useSummaryStreamFn(harness, "local summary");

			await expect(harness.session.compact()).rejects.toThrow(
				"Built-in compaction is disabled; enable compaction or configure a compaction extension",
			);
			expect(getStreamCallCount()).toBe(0);
		},
	);

	it("does not use local compaction when a disabled compaction handler throws", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async () => {
						throw new Error("compaction provider failed");
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "local summary");

		await expect(harness.session.compact()).rejects.toThrow(
			"Built-in compaction is disabled; enable compaction or configure a compaction extension",
		);
		expect(getStreamCallCount()).toBe(0);
	});

	it("runs compaction extensions during disabled auto-compaction", async () => {
		let extensionCalls = 0;
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => {
						extensionCalls++;
						return {
							compaction: {
								summary: "extension summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "local summary");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(
			sessionInternals._checkCompaction(createAssistant(harness, { totalTokens: 1_000_000 })),
		).resolves.toBe(false);
		expect(extensionCalls).toBe(1);
		expect(getStreamCallCount()).toBe(0);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
	});

	it("surfaces disabled auto-compaction failure when no extension provides a result", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 2_000_000 }],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "local summary");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(
			sessionInternals._checkCompaction(createAssistant(harness, { totalTokens: 1_990_000 })),
		).resolves.toBe(false);
		expect(getStreamCallCount()).toBe(0);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			errorMessage:
				"Auto-compaction failed: Built-in compaction is disabled; enable compaction or configure a compaction extension",
		});
	});

	it("reports kept suffix tokens independently from remote compaction result size", async () => {
		const compactedResultTokens = 999_999;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							compactedResultTokens,
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const result = await harness.session.compact();
		const syntheticTokensAfter = harness.session.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
		const summaryMessage = harness.session.messages[0];
		if (!summaryMessage) throw new Error("Expected compaction summary message");
		const keptSuffixTokens = syntheticTokensAfter - estimateTokens(summaryMessage);

		expect(keptSuffixTokens).toBeGreaterThan(0);
		expect(result.keptFromPreviousContextTokens).toBe(keptSuffixTokens);
		expect(result.estimatedTokensAfter).toBe(keptSuffixTokens + compactedResultTokens);
	});

	it("manually compacts using the purpose-built compaction hook before local compaction", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => ({
						compaction: {
							summary: "summary from compaction provider",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							source: { type: "openai_remote", provider: "openai", model: "gpt-4.1-mini" },
							providerNative: {
								provider: "openai",
								api: "openai-responses",
								format: "openai.responses.input",
								value: [{ type: "compaction", encrypted_content: "encrypted" }],
							},
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const result = await harness.session.compact();
		const [compactionEntry] = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const [summaryMessage] = harness.session.messages;

		expect(result.summary).toBe("summary from compaction provider");
		expect(result.source).toEqual({ type: "openai_remote", provider: "openai", model: "gpt-4.1-mini" });
		expect(harness.eventsOfType("compaction_start").at(-1)).toMatchObject({ sourceHint: undefined });
		expect(compactionEntry).toMatchObject({
			summary: "summary from compaction provider",
			fromHook: true,
			providerNative: {
				provider: "openai",
				api: "openai-responses",
				format: "openai.responses.input",
				value: [{ type: "compaction", encrypted_content: "encrypted" }],
			},
		});
		expect(summaryMessage).toMatchObject({
			role: "compactionSummary",
			providerNative: {
				provider: "openai",
				api: "openai-responses",
				format: "openai.responses.input",
				value: [{ type: "compaction", encrypted_content: "encrypted" }],
			},
		});
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.compact()).rejects.toThrow("No model selected");
	});

	it("throws when compacting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.compact()).rejects.toThrow(`No API key found for ${harness.getModel().provider}.`);
	});

	it("manually compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();
		const compactionEntry = harness.sessionManager.getEntries().find((entry) => entry.type === "compaction");

		expect(result.summary).toContain("summary from custom stream");
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		expect(compactionEntry).toMatchObject({ durationMs: result.durationMs });
		expect(getStreamCallCount()).toBe(1);
	});

	it("serializes manual compaction with racing prompts in FIFO order", async () => {
		const compactionStarted = createDeferred<void>();
		const releaseCompaction = createDeferred<void>();
		let compactionEnded = false;
		let promptStartedBeforeCompactionEnd = false;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("input", () => {
						if (!compactionEnded) {
							promptStartedBeforeCompactionEnd = true;
						}
					});
					pi.on("compaction", async (event) => {
						compactionStarted.resolve();
						await releaseCompaction.promise;
						return {
							compaction: {
								summary: "gated summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.reason === "manual") {
				compactionEnded = true;
			}
		});
		seedCompactableSession(harness);
		harness.setResponses([fauxCompletedTurn("first response"), fauxCompletedTurn("second response")]);

		const compactPromise = harness.session.compact();
		await compactionStarted.promise;
		const firstPrompt = harness.session.prompt("first prompt");
		const secondPrompt = harness.session.prompt("second prompt", { streamingBehavior: "followUp" });

		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		releaseCompaction.resolve();

		await expect(compactPromise).resolves.toMatchObject({ summary: "gated summary" });
		await expect(firstPrompt).resolves.toBeUndefined();
		await expect(secondPrompt).resolves.toBeUndefined();
		await harness.session.agent.waitForIdle();

		expect(harness.session.isStreaming).toBe(false);
		expect(promptStartedBeforeCompactionEnd).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(getUserTexts(harness).slice(-2)).toEqual(["first prompt", "second prompt"]);
		expect(getAssistantTexts(harness).slice(-2)).toEqual(["first response", "second response"]);
	});

	it("auto-compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "auto summary from custom stream");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEntries[0]?.durationMs).toBeGreaterThanOrEqual(0);
		expect(compactionEnd?.result?.durationMs).toBe(compactionEntries[0]?.durationMs);
		expect(compactionEnd?.result?.estimatedTokensAfter).toBeGreaterThan(0);
		expect(getStreamCallCount()).toBe(1);
	});

	it("manually compacts when a hook clears the externally visible abort controller", async () => {
		const sessionInternalsRef: { current?: SessionWithCompactionAbortInternals } = {};
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => {
						requireSessionInternals(sessionInternalsRef)._compactionAbortController = undefined;
						return {
							compaction: {
								summary: "manual compacted after controller clear",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		sessionInternalsRef.current = harness.session as unknown as SessionWithCompactionAbortInternals;
		seedCompactableSession(harness);

		await expect(harness.session.compact()).resolves.toMatchObject({
			summary: "manual compacted after controller clear",
		});
	});

	it("auto-compacts with the original abort signal when a hook replaces the visible controller", async () => {
		const sessionInternalsRef: { current?: SessionWithCompactionAbortInternals } = {};
		const replacementController = new AbortController();
		replacementController.abort();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => {
						requireSessionInternals(sessionInternalsRef)._autoCompactionAbortController = replacementController;
						return {
							compaction: {
								summary: "auto compacted after controller replacement",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		sessionInternalsRef.current = harness.session as unknown as SessionWithCompactionAbortInternals;
		seedCompactableSession(harness);
		const sessionInternals = requireSessionInternals(sessionInternalsRef);

		await sessionInternals._runAutoCompaction("threshold", false);

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEnd).toMatchObject({ aborted: false, reason: "threshold" });
		expect(sessionInternals._autoCompactionAbortController).toBe(replacementController);
		sessionInternals._autoCompactionAbortController = undefined;
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxCompletedTurn("one"), fauxCompletedTurn("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(true);
	});

	it("continues after manual compaction aborts an unanswered user turn", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => ({
						compaction: {
							summary: "manual compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const now = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "old request" }],
			timestamp: now - 4000,
		});
		harness.sessionManager.appendMessage(
			createAssistant(harness, { stopReason: "stop", totalTokens: 100, timestamp: now - 3000 }),
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "middle request" }],
			timestamp: now - 2000,
		});
		harness.sessionManager.appendMessage(
			createAssistant(harness, { stopReason: "stop", totalTokens: 100, timestamp: now - 1000 }),
		);
		const latestUser = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "keep working" }],
			timestamp: now,
		};
		harness.sessionManager.appendMessage(latestUser);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxCompletedTurn("continued after compact")]);

		await harness.session.compact();

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ reason: "manual", willRetry: true });
	});

	it("continues after manual compaction starts from a running tool turn", async () => {
		const sessionRef: { current?: Harness["session"] } = {};
		const compactTool: AgentTool = {
			name: "compact_now",
			label: "Compact Now",
			description: "Start compaction from inside a tool turn",
			parameters: Type.Object({}),
			async execute() {
				const session = sessionRef.current;
				if (!session) throw new Error("Session was not assigned");
				session.extensionRunner.createContext().compact();
				return { content: [{ type: "text", text: "started" }], details: {} };
			},
		};
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			tools: [compactTool],
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => ({
						compaction: {
							summary: "manual compacted from tool",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		sessionRef.current = harness.session;
		harness.setResponses([
			fauxCompletedTurn("old request complete"),
			fauxAssistantMessage(fauxToolCall("compact_now", {}), { stopReason: "toolUse" }),
			fauxCompletedTurn("continued after compact"),
		]);

		await harness.session.prompt("old request");
		const resumed = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "agent_end" && getAssistantTexts(harness).includes("continued after compact")) {
					unsubscribe();
					resolve();
				}
			});
		});
		await harness.session.prompt("compact and keep going");
		await resumed;

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ reason: "manual", willRetry: true });
		expect(harness.faux.state.callCount).toBe(3);
		expect(getAssistantTexts(harness)).toContain("continued after compact");
	});

	it("does not continue after manual compaction when latest assistant completed", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => ({
						compaction: {
							summary: "manual compacted complete turn",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxCompletedTurn("first complete"), fauxCompletedTurn("complete")]);

		await harness.session.prompt("first done turn");
		await harness.session.prompt("done turn");
		await harness.session.compact();

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ reason: "manual", willRetry: false });
	});

	it("does not retry request-buffer overflow recovery more than once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "Error: exceeded request buffer limit while retrying upstream",
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkCompaction(overflowMessage);
		await sessionInternals._checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("compacts and retries request-buffer overflow without ordinary auto-retry", async () => {
		let compactionCalls = 0;
		let retryContextChecked = false;
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 5_000 } },
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => {
						compactionCalls++;
						return {
							compaction: {
								summary: "request-buffer overflow summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([
			async () => {
				expect(compactionCalls).toBe(0);
				expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
				return fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Error: exceeded request buffer limit while retrying upstream",
				});
			},
			async () => {
				const compactionEntries = harness.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "compaction");
				expect(compactionEntries).toHaveLength(1);
				retryContextChecked = true;
				return fauxCompletedTurn("recovered after request-buffer overflow");
			},
		]);

		await harness.session.prompt("trigger request-buffer overflow recovery");

		expect(retryContextChecked).toBe(true);
		expect(compactionCalls).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expect(harness.eventsOfType("auto_retry_end")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: true,
		});
		expect(harness.faux.state.callCount).toBe(2);
		expect(getAssistantTexts(harness)).toContain("recovered after request-buffer overflow");
	});

	it("compacts once and reports bounded failure after repeated request-buffer overflow", async () => {
		let compactionCalls = 0;
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 5_000 } },
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => {
						compactionCalls++;
						return {
							compaction: {
								summary: "repeated request-buffer overflow summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([
			async () =>
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Error: exceeded request buffer limit while retrying upstream",
				}),
			async () =>
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Error: exceeded request buffer limit while retrying upstream",
				}),
		]);

		await expect(harness.session.prompt("trigger repeated request-buffer overflow")).resolves.toBeUndefined();

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const compactionEnds = harness.eventsOfType("compaction_end");
		expect(harness.faux.state.callCount).toBe(2);
		expect(compactionCalls).toBe(1);
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEntries[0]).toMatchObject({ summary: "repeated request-buffer overflow summary" });
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expect(harness.eventsOfType("auto_retry_end")).toHaveLength(0);
		expect(compactionEnds.at(-1)).toMatchObject({
			reason: "overflow",
			result: undefined,
			aborted: false,
			willRetry: false,
			errorMessage:
				"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		});
	});

	it("surfaces request-buffer compaction failure without issuing a retry", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 5_000 } },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "Error: exceeded request buffer limit while retrying upstream",
			}),
		]);

		await expect(harness.session.prompt("trigger failed request-buffer compaction")).resolves.toBeUndefined();

		const compactionEnds = harness.eventsOfType("compaction_end");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expect(harness.eventsOfType("auto_retry_end")).toHaveLength(0);
		expect(compactionEnds.at(-1)).toMatchObject({
			reason: "overflow",
			result: undefined,
			aborted: false,
			willRetry: false,
			errorMessage:
				"Context overflow recovery failed: Built-in compaction is disabled; enable compaction or configure a compaction extension",
		});
	});

	it("compacts and retries overflow after repeated small tool results fill one turn", async () => {
		const smallResultText = "x".repeat(4_000);
		const repeatedResultTool: AgentTool = {
			name: "repeated_result",
			label: "Repeated Result",
			description: "Return one ordinary-sized result",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: smallResultText }], details: {} }),
		};
		let compactionCalls = 0;
		let retryContextChecked = false;
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 5_000 } },
			models: [{ id: "faux-1", contextWindow: 30_000, maxTokens: 100 }],
			tools: [repeatedResultTool],
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => {
						compactionCalls++;
						return {
							compaction: {
								summary: "repeated-results overflow summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		const toolCycles = Array.from({ length: 24 }, () =>
			fauxAssistantMessage(fauxToolCall("repeated_result", {}), { stopReason: "toolUse" }),
		);
		harness.setResponses([
			...toolCycles,
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage:
					"Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.",
			}),
			async (context) => {
				retryContextChecked = true;
				const retainedResultCount = expectToolResultsToFollowCalls(context.messages, "repeated_result");
				expect(retainedResultCount).toBeGreaterThan(0);
				await new Promise((resolve) => setTimeout(resolve, 5));
				return fauxCompletedTurn("recovered after repeated results overflow");
			},
		]);

		await harness.session.prompt("start one cumulative tool turn");

		const repeatedResults = harness.sessionManager
			.getEntries()
			.filter(
				(entry): entry is SessionMessageEntry & { message: ToolResultMessage } =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolName === "repeated_result",
			);
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(repeatedResults).toHaveLength(toolCycles.length);
		expect(
			repeatedResults.every((entry) =>
				entry.message.content.every(
					(block) => block.type !== "text" || block.text.length <= smallResultText.length,
				),
			),
		).toBe(true);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: true,
		});
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEntries[0]).toMatchObject({ summary: "repeated-results overflow summary" });
		expect(compactionCalls).toBe(1);
		expect(retryContextChecked).toBe(true);
		expect(harness.faux.state.callCount).toBe(toolCycles.length + 2);
		expect(getAssistantTexts(harness)).toContain("recovered after repeated results overflow");
	});

	it("compacts successful overflow responses without retrying", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => ({
						compaction: {
							summary: "successful overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([fauxCompletedTurn("completed answer")]);

		await expect(harness.session.prompt("hello")).resolves.toBeUndefined();

		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: false,
		});
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("ignores stale pre-compaction assistant usage on pre-prompt checks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const staleTimestamp = Date.now() - 10_000;
		const staleAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 610_000,
			timestamp: staleTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			staleAssistant.usage.totalTokens,
			undefined,
			false,
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after compaction" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("triggers threshold compaction for error messages using the last successful usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "retry" }], timestamp: Date.now() + 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("does not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction when only kept pre-compaction usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const preCompactionTimestamp = Date.now() - 10_000;
		const keptAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: preCompactionTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			keptAssistant.usage.totalTokens,
			undefined,
			false,
		);

		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "kept user" }], timestamp: preCompactionTimestamp - 1000 },
			keptAssistant,
			{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() - 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("requests retry when threshold compaction follows a length-truncated turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const lengthAssistant = createAssistant(harness, {
			stopReason: "length",
			totalTokens: 120_000,
			timestamp: Date.now(),
		});
		// Truncated turns still produced output; output 0 would classify as overflow instead.
		lengthAssistant.usage.output = 500;

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(true);

		await sessionInternals._checkCompaction(lengthAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", true);
	});

	it("does not retry a length-truncated turn on pre-prompt compaction checks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const lengthAssistant = createAssistant(harness, {
			stopReason: "length",
			totalTokens: 120_000,
			timestamp: Date.now(),
		});
		lengthAssistant.usage.output = 500;

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(true);

		await sessionInternals._checkCompaction(lengthAssistant, false);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("compacts and resumes a length-truncated turn", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 400, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => ({
						compaction: {
							summary: "length recovery compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([
			delayedResponse("truncated output", { stopReason: "length" }),
			delayedCompletedTurn("resumed output"),
		]);

		await harness.session.prompt("x".repeat(4000));

		const compactionEnds = harness.eventsOfType("compaction_end");
		expect(compactionEnds.some((event) => event.reason === "threshold" && event.willRetry === true)).toBe(true);
		expect(harness.faux.state.callCount).toBe(2);
		expect(getAssistantTexts(harness)).toContain("resumed output");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		expect(sessionInternals._lengthRecoveryAttempted).toBe(false);
		// The truncated message is stripped from agent state but stays in session history.
		const truncatedInAgentState = harness.session.agent.state.messages.filter(
			(message) => message.role === "assistant" && (message as AssistantMessage).stopReason === "length",
		);
		expect(truncatedInAgentState).toHaveLength(0);
		const truncatedInHistory = harness.sessionManager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					(entry.message as AssistantMessage).stopReason === "length",
			);
		expect(truncatedInHistory).toHaveLength(1);
	});

	it("resets the length-recovery guard on the next user prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		sessionInternals._lengthRecoveryAttempted = true;
		// A "length"-stopped reply cannot reset the guard itself, so a cleared flag
		// proves the reset came from the user message starting the turn.
		harness.setResponses([fauxAssistantMessage("still truncated", { stopReason: "length" })]);

		await harness.session.prompt("new work");

		expect(sessionInternals._lengthRecoveryAttempted).toBe(false);
	});

	it("does not resume a second consecutive length-truncated turn", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 400, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => ({
						compaction: {
							summary: "length recovery compacted again",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([
			delayedResponse("first truncated", { stopReason: "length" }),
			delayedResponse("second truncated", { stopReason: "length" }),
			delayedResponse("never reached"),
		]);

		await harness.session.prompt("x".repeat(4000));

		const compactionEnds = harness.eventsOfType("compaction_end");
		expect(compactionEnds.at(-1)).toMatchObject({ reason: "threshold", willRetry: false });
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("reports a failed background compaction without starting foreground compaction", async () => {
		const overloadError =
			"Codex error: Our servers are currently overloaded. Please try again later.";
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async () => {
						throw new Error(overloadError);
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		expect(sessionInternals._extensionRunner.hasHandlers("compaction")).toBe(true);
		vi.spyOn(sessionInternals._extensionRunner, "emit").mockRejectedValue(new Error(overloadError));

		await expect(
			sessionInternals._checkCompaction(
				createAssistant(harness, { stopReason: "stop", totalTokens: 70, timestamp: Date.now() }),
			),
		).resolves.toBe(false);
		await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(1));

		expect(errorSpy).toHaveBeenCalledWith(`Background compaction cache generation failed: ${overloadError}`);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(0);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("starts speculative compaction during a multi-cycle turn and consumes it at safe end", async () => {
		const contextWindow = 1000;
		const reserveTokens = 200;
		const backgroundTriggerTokens = contextWindow * 0.7;
		const compactionThresholdTokens = contextWindow - reserveTokens;
		const releaseCompaction = createDeferred<void>();
		const firstToolStarted = createDeferred<void>();
		const releaseFirstTool = createDeferred<void>();
		let compactionCalls = 0;
		const blockedTool: AgentTool = {
			name: "blocked_tool",
			label: "Blocked Tool",
			description: "Wait until the test releases the first tool",
			parameters: Type.Object({}),
			execute: async () => {
				firstToolStarted.resolve();
				await releaseFirstTool.promise;
				return { content: [{ type: "text", text: "first tool" }], details: {} };
			},
		};
		const secondTool: AgentTool = {
			name: "second_tool",
			label: "Second Tool",
			description: "Complete the second tool cycle",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "second tool" }], details: {} }),
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow, maxTokens: 100 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens } },
			tools: [blockedTool, secondTool],
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => {
						compactionCalls++;
						await releaseCompaction.promise;
						return {
							compaction: {
								summary: "mid-turn cached summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		const historyTimestamp = Date.now() - 1000;
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "older turn to compact" }],
			timestamp: historyTimestamp,
		});
		const historyAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 60,
			timestamp: historyTimestamp + 1,
		});
		historyAssistant.content = [{ type: "text", text: "older response to compact" }];
		harness.sessionManager.appendMessage(historyAssistant);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		const firstResponse = fauxAssistantMessage(fauxToolCall("blocked_tool", {}), { stopReason: "toolUse" });
		const secondResponse = fauxAssistantMessage(fauxToolCall("second_tool", {}), { stopReason: "toolUse" });
		harness.setResponses([
			firstResponse,
			secondResponse,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "completed" }), { stopReason: "toolUse" }),
		]);

		let promptPromise: Promise<void> | undefined;
		try {
			promptPromise = harness.session.prompt("run multiple tool cycles");
			await firstToolStarted.promise;
			const firstAssistantEnd = harness
				.eventsOfType("message_end")
				.find((event) => event.message.role === "assistant");
			if (!firstAssistantEnd || firstAssistantEnd.message.role !== "assistant") {
				throw new Error("Expected the first assistant message to finish before tool execution");
			}
			expect(firstAssistantEnd.message.usage.totalTokens).toBeGreaterThanOrEqual(backgroundTriggerTokens);
			expect(firstAssistantEnd.message.usage.totalTokens).toBeLessThan(compactionThresholdTokens);
			await vi.waitFor(() => expect(compactionCalls).toBe(1), { timeout: 100 });
			expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
			expect(harness.eventsOfType("agent_end")).toHaveLength(0);
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);

			releaseCompaction.resolve();
			await new Promise((resolve) => setTimeout(resolve, 0));
			releaseFirstTool.resolve();
			await promptPromise;

			expect(compactionCalls).toBe(1);
			expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
				reason: "threshold",
				aborted: false,
				result: { summary: "mid-turn cached summary" },
			});
			const branchText = harness.sessionManager
				.getBranch()
				.map((entry) => JSON.stringify(entry))
				.join("\n");
			expect(branchText).toContain("first tool");
			expect(branchText).toContain("second tool");
			expect(branchText).toContain("completed");
		} finally {
			releaseCompaction.resolve();
			releaseFirstTool.resolve();
			if (promptPromise) await promptPromise;
		}
	});

	it("starts exactly one speculative compaction when context crosses 70%", async () => {
		const releaseCompaction = createDeferred<void>();
		let compactionCalls = 0;
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => {
						compactionCalls++;
						await releaseCompaction.promise;
						return {
							compaction: {
								summary: "speculative summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const entriesBefore = structuredClone(harness.sessionManager.getEntries());
		const messagesBefore = structuredClone(harness.session.messages);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._checkCompaction(
			createAssistant(harness, { stopReason: "stop", totalTokens: 69, timestamp: Date.now() }),
		);
		expect(compactionCalls).toBe(0);

		const firstCompaction = sessionInternals._checkCompaction(
			createAssistant(harness, { stopReason: "stop", totalTokens: 70, timestamp: Date.now() + 1 }),
		);
		let repeatedCompaction: Promise<boolean> | undefined;
		try {
			await vi.waitFor(() => expect(compactionCalls).toBe(1), { timeout: 100 });
			repeatedCompaction = sessionInternals._checkCompaction(
				createAssistant(harness, { stopReason: "stop", totalTokens: 75, timestamp: Date.now() + 2 }),
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(compactionCalls).toBe(1);
			expect(harness.sessionManager.getEntries()).toEqual(entriesBefore);
			expect(harness.session.messages).toEqual(messagesBefore);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		} finally {
			releaseCompaction.resolve();
			await firstCompaction;
			if (repeatedCompaction) await repeatedCompaction;
		}
		expect(compactionCalls).toBe(1);
	});

	it("installs a completed background compaction cache as real threshold compaction while idle", async () => {
		const releaseCompaction = createDeferred<void>();
		let compactionCalls = 0;
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => {
						compactionCalls++;
						await releaseCompaction.promise;
						return {
							compaction: {
								summary: "completed background summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		const speculativeCompaction = sessionInternals._checkCompaction(
			createAssistant(harness, { stopReason: "stop", totalTokens: 70, timestamp: Date.now() }),
		);
		try {
			await vi.waitFor(() => expect(compactionCalls).toBe(1), { timeout: 100 });
			releaseCompaction.resolve();
			await vi.waitFor(() => expect(harness.eventsOfType("compaction_end")).toHaveLength(1), { timeout: 100 });

			expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({
				reason: "threshold",
				aborted: false,
				willRetry: false,
				result: { summary: "completed background summary" },
			});
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
			expect(compactionCalls).toBe(1);
		} finally {
			releaseCompaction.resolve();
			await speculativeCompaction;
		}
	});

	it("preserves a second user turn when committing a background compaction from the first turn", async () => {
		const releaseCompaction = createDeferred<void>();
		const secondTurnStarted = createDeferred<void>();
		const releaseSecondTurn = createDeferred<void>();
		let compactionCalls = 0;
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 6000, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => {
						compactionCalls++;
						await releaseCompaction.promise;
						return {
							compaction: {
								summary: "summary generated after first user turn",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.sessionManager.appendMessage(
			createAssistant(harness, { stopReason: "stop", totalTokens: 1, timestamp: Date.now() }),
		);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			async () => {
				const response = createAssistant(harness, { stopReason: "toolUse", totalTokens: 70 });
				response.content = [
					{ type: "text", text: "first turn completed" },
					fauxToolCall("end_turn", { reason: "first turn completed" }),
				];
				return response;
			},
			async () => {
				secondTurnStarted.resolve();
				await releaseSecondTurn.promise;
				const response = createAssistant(harness, { stopReason: "toolUse", totalTokens: 10 });
				response.content = [
					{ type: "text", text: "second turn completed" },
					fauxToolCall("end_turn", { reason: "second turn completed" }),
				];
				return response;
			},
			fauxAssistantMessage("unexpected third call"),
		]);

		let firstPromptSettled = false;
		const firstPrompt = harness.session.prompt("first user message").then(() => {
			firstPromptSettled = true;
		});
		await vi.waitFor(() => expect(compactionCalls).toBe(1), { timeout: 100 });
		await vi.waitFor(() => expect(firstPromptSettled).toBe(true), { timeout: 100 });
		await firstPrompt;

		const secondPrompt = harness.session.prompt("second user message");
		await secondTurnStarted.promise;
		releaseCompaction.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);

		releaseSecondTurn.resolve();
		await secondPrompt;

		const branch = harness.sessionManager.getBranch();
		const compactionEntries = branch.filter((entry) => entry.type === "compaction");
		const branchUserTexts = branch.flatMap((entry) => {
			if (entry.type !== "message" || entry.message.role !== "user") return [];
			const content = entry.message.content;
			return typeof content === "string"
				? [content]
				: content.filter((part) => part.type === "text").map((part) => part.text);
		});

		expect(compactionEntries).toHaveLength(1);
		expect(compactionEntries[0]).toMatchObject({ summary: "summary generated after first user turn" });
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			willRetry: false,
			result: { summary: "summary generated after first user turn" },
		});
		expect(getUserTexts(harness)).toContain("second user message");
		expect(branchUserTexts).toContain("second user message");
		expect(getAssistantTexts(harness)).toContain("second turn completed");
		expect(compactionCalls).toBe(1);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it.each([
		{
			name: "compaction settings change",
			mutate: (harness: Harness) => harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 2 } }),
		},
		{
			name: "system prompt change",
			mutate: (harness: Harness) => {
				harness.session.agent.state.systemPrompt = "Changed system prompt";
			},
		},
		{
			name: "model change",
			mutate: (harness: Harness) => {
				const nextModel = harness.getModel("faux-2");
				if (!nextModel) throw new Error("Expected faux-2 model");
				harness.session.agent.state.model = nextModel;
			},
		},
		{
			name: "session change",
			mutate: (harness: Harness) => {
				harness.sessionManager.newSession();
				harness.session.agent.state.messages = [];
			},
		},
	])("discards a ready background cache after $name without compacting below threshold", async ({ mutate }) => {
		const releaseCompaction = createDeferred<void>();
		let compactionCalls = 0;
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [
				{ id: "faux-1", contextWindow: 100, maxTokens: 100 },
				{ id: "faux-2", contextWindow: 100, maxTokens: 100 },
			],
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => {
						compactionCalls++;
						if (compactionCalls === 1) await releaseCompaction.promise;
						return {
							compaction: {
								summary: "invalidated background summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const speculativeCompaction = sessionInternals._checkCompaction(
			createAssistant(harness, { stopReason: "stop", totalTokens: 70, timestamp: Date.now() }),
		);

		await vi.waitFor(() => expect(compactionCalls).toBe(1), { timeout: 100 });
		mutate(harness);
		releaseCompaction.resolve();
		await speculativeCompaction;
		await new Promise((resolve) => setTimeout(resolve, 25));

		expect(compactionCalls).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("does not install or replace a stale background cache after branch navigation below threshold", async () => {
		const releaseCompaction = createDeferred<void>();
		let compactionCalls = 0;
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => {
						compactionCalls++;
						if (compactionCalls === 1) await releaseCompaction.promise;
						return {
							compaction: {
								summary: "stale background summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const branchTargetId = harness.sessionManager.getBranch()[1]?.id;
		if (!branchTargetId) throw new Error("Expected an assistant entry to branch to");
		const speculativeCompaction = sessionInternals._checkCompaction(
			createAssistant(harness, { stopReason: "stop", totalTokens: 70, timestamp: Date.now() }),
		);

		await vi.waitFor(() => expect(compactionCalls).toBe(1), { timeout: 100 });
		await harness.session.navigateTree(branchTargetId, { summarize: false });
		compactionCalls = 0;
		releaseCompaction.resolve();
		await speculativeCompaction;
		await new Promise((resolve) => setTimeout(resolve, 25));

		expect(compactionCalls).toBe(0);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(0);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("aborts pending background compaction before synchronous threshold fallback without overlapping handlers", async () => {
		const backgroundStarted = createDeferred<void>();
		let activeCompactions = 0;
		let maxActiveCompactions = 0;
		let compactionCalls = 0;
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 20 } },
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => {
						compactionCalls++;
						activeCompactions++;
						maxActiveCompactions = Math.max(maxActiveCompactions, activeCompactions);
						try {
							if (compactionCalls === 1) {
								backgroundStarted.resolve();
								await new Promise<void>((resolve) => {
									event.signal.addEventListener("abort", () => resolve(), { once: true });
								});
							}
							return {
								compaction: {
									summary: "synchronous fallback summary",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
									details: {},
								},
							};
						} finally {
							activeCompactions--;
						}
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const backgroundCompaction = sessionInternals._checkCompaction(
			createAssistant(harness, { stopReason: "stop", totalTokens: 70, timestamp: Date.now() }),
		);
		await backgroundStarted.promise;

		await sessionInternals._checkCompaction(
			createAssistant(harness, { stopReason: "stop", totalTokens: 81, timestamp: Date.now() + 1 }),
		);
		await backgroundCompaction;

		expect(compactionCalls).toBe(2);
		expect(maxActiveCompactions).toBe(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
			result: { summary: "synchronous fallback summary" },
		});
	});

	it("does not trigger threshold compaction below the threshold and still attempts extensions when disabled", async () => {
		const belowThresholdHarness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(belowThresholdHarness);
		const disabledHarness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(disabledHarness);

		const belowThresholdInternals = belowThresholdHarness.session as unknown as SessionWithCompactionInternals;
		const disabledInternals = disabledHarness.session as unknown as SessionWithCompactionInternals;
		const belowThresholdSpy = vi.spyOn(belowThresholdInternals, "_runAutoCompaction").mockResolvedValue(false);
		const disabledSpy = vi.spyOn(disabledInternals, "_runAutoCompaction").mockResolvedValue(false);

		await belowThresholdInternals._checkCompaction(
			createAssistant(belowThresholdHarness, { stopReason: "stop", totalTokens: 1_000, timestamp: Date.now() }),
		);
		await disabledInternals._checkCompaction(
			createAssistant(disabledHarness, { stopReason: "stop", totalTokens: 1_000_000, timestamp: Date.now() }),
		);

		expect(belowThresholdSpy).not.toHaveBeenCalled();
		expect(disabledSpy).toHaveBeenCalledWith("overflow", false);
	});
});
