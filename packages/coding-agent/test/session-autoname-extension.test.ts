import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
	type Context,
	type FauxResponseFactory,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import sessionAutonameExtension from "../extensions/session-autoname/src/index.ts";
import type { ExtensionMode } from "../src/core/extensions/types.ts";
import { getControlDbPath, readSessionMetadata } from "../src/core/session-control-db.ts";
import { createHarness, type Harness, type HarnessOptions } from "./suite/harness.ts";

const ASYNC_SETTLEMENT_TIMEOUT_MS = 1_000;
const BACKGROUND_SETTLEMENT_DELAY_MS = 50;
const PROMPT_SETTLEMENT_TIMEOUT_MS = 500;

async function waitUntil(predicate: () => boolean, timeoutMs = ASYNC_SETTLEMENT_TIMEOUT_MS): Promise<boolean> {
	const deadline = performance.now() + timeoutMs;
	while (!predicate() && performance.now() < deadline) {
		await delay(5);
	}
	return predicate();
}

type SessionAutonameHarnessOptions = Omit<HarnessOptions, "resourceLoader"> & { mode?: ExtensionMode };

async function createSessionAutonameHarness(options: SessionAutonameHarnessOptions = {}): Promise<Harness> {
	const { mode = "tui", ...harnessOptions } = options;
	const harness = await createHarness({
		...harnessOptions,
		extensionFactories: [sessionAutonameExtension],
	});
	await harness.session.bindExtensions({ mode });
	return harness;
}

function routeMainAndTitleResponses(harness: Harness, responses: FauxResponseStep[]): void {
	const mainResponses = responses.slice(0, -1);
	const titleResponse = responses.at(-1);
	if (!titleResponse) throw new Error("Expected a title response");
	const route: FauxResponseFactory = (context, options, state, model) => {
		const response = context.systemPrompt?.includes("session title") ? titleResponse : mainResponses.shift();
		if (!response) throw new Error("Unexpected main response request");
		return typeof response === "function" ? response(context, options, state, model) : response;
	};
	harness.setResponses(responses.map(() => route));
}

function completedAssistantMessage(text: string) {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })], {
		stopReason: "toolUse",
	});
}

function emptyCompletedAssistantMessage() {
	return fauxAssistantMessage(fauxToolCall("end_turn", { reason: "No substantive response" }), {
		stopReason: "toolUse",
	});
}

function failedAssistantMessage() {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" });
}

describe("session autoname extension", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		for (const harness of harnesses) {
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
		}
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function startTitleAttempt(responses: Parameters<Harness["setResponses"]>[0]): Promise<Harness> {
		const harness = await createSessionAutonameHarness({ persistedSession: true });
		harnesses.push(harness);
		harness.setResponses(responses);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		await harness.session.extensionRunner.emit({
			type: "message_start",
			message: { role: "user", content: "Name this session.", inputSource: "interactive", timestamp: Date.now() },
		});
		await vi.advanceTimersByTimeAsync(0);
		return harness;
	}

	it("retries a transient title failure without another user message", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const harness = await startTitleAttempt([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
			fauxAssistantMessage("Recovered Session Title"),
		]);
		expect(harness.faux.state.callCount).toBe(1);
		await delay(900);
		expect(harness.faux.state.callCount).toBe(1);
		expect(await waitUntil(() => harness.faux.state.callCount === 2, 1_500)).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.sessionManager.getSessionName()).toBe("Recovered Session Title");
	});

	it.each(["invalid_api_key", "retry delay exceeds configured maximum"])(
		"does not retry permanent or provider delay-cap errors: %s",
		async (errorMessage) => {
			const errors = vi.spyOn(console, "error").mockImplementation(() => {});
			const harness = await startTitleAttempt([
				fauxAssistantMessage("", { stopReason: "error", errorMessage }),
				fauxAssistantMessage("Unexpected Retry"),
			]);
			await delay(1_300);
			await vi.advanceTimersByTimeAsync(0);
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.sessionManager.getSessionName()).toBeUndefined();
			expect(errors.mock.calls.flat().join(" ")).toContain(errorMessage);
		},
	);

	it("caps transient title attempts at three and reports exhausted failure", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const failure = fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" });
		const harness = await startTitleAttempt([failure, failure, failure, fauxAssistantMessage("Unexpected Retry")]);
		expect(await waitUntil(() => harness.faux.state.callCount === 3, 4_000)).toBe(true);
		await delay(4_300);
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
		expect(errors.mock.calls.flat().join(" ")).toContain("503 service unavailable");
	}, 10_000);

	it("reports the 15-second title timeout and retries", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const harness = await startTitleAttempt([
			async (_context, options) => {
				await new Promise<void>((resolve) =>
					options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
				return fauxAssistantMessage("", { stopReason: "aborted" });
			},
			fauxAssistantMessage("Timeout Recovery Title"),
		]);
		await vi.advanceTimersByTimeAsync(14_999);
		expect(harness.faux.state.callCount).toBe(1);
		expect(errors).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(errors.mock.calls.flat().join(" ")).toMatch(/timed out|timeout/i);
		expect(await waitUntil(() => harness.faux.state.callCount === 2, 1_500)).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.sessionManager.getSessionName()).toBe("Timeout Recovery Title");
	});

	it.each(["shutdown", "name", "clear"] as const)("cancels title retry backoff on %s", async (action) => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const harness = await startTitleAttempt([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
			fauxAssistantMessage("Unexpected Retry"),
		]);
		expect(harness.faux.state.callCount).toBe(1);
		if (action === "shutdown") {
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
		} else if (action === "name") {
			harness.session.setSessionName("Manual During Backoff");
		} else {
			harness.session.clearSessionName();
		}
		await delay(1_300);
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getSessionName()).toBe(action === "name" ? "Manual During Backoff" : undefined);
	});

	it.each(["tui", "rpc"] as const)(
		"names a %s session while the first assistant response remains blocked",
		async (mode) => {
			let releaseAssistantResponse: (() => void) | undefined;
			const assistantResponseReleased = new Promise<void>((resolve) => {
				releaseAssistantResponse = resolve;
			});
			let assistantRequestStarted = false;
			let assistantResponseReturned = false;
			const harness = await createSessionAutonameHarness({ mode, persistedSession: true });
			harnesses.push(harness);
			const respondToContext = async (context: Context) => {
				if (context.systemPrompt?.includes("session title")) {
					return fauxAssistantMessage("Early Session Naming");
				}
				assistantRequestStarted = true;
				await assistantResponseReleased;
				assistantResponseReturned = true;
				return completedAssistantMessage("The first assistant response is now released.");
			};
			harness.setResponses([respondToContext, respondToContext]);

			const prompt = harness.session.prompt("Name this session before its first answer finishes.", {
				source: mode === "rpc" ? "rpc" : "interactive",
			});
			try {
				expect(await waitUntil(() => assistantRequestStarted)).toBe(true);
				expect(await waitUntil(() => harness.sessionManager.getSessionName() !== undefined)).toBe(true);
				expect(assistantResponseReturned).toBe(false);
				expect(harness.sessionManager.getSessionName()).toBe("Early Session Naming");
				const sessionFile = harness.sessionManager.getSessionFile();
				expect(sessionFile).toBeDefined();
				expect(readSessionMetadata(getControlDbPath(harness.tempDir), sessionFile ?? "")?.name).toBe(
					"Early Session Naming",
				);
				expect(harness.eventsOfType("session_info_changed").map((event) => event.name)).toEqual([
					"Early Session Naming",
				]);
			} finally {
				releaseAssistantResponse?.();
				await prompt;
				await waitUntil(() => harness.sessionManager.getSessionName() !== undefined);
			}
		},
	);

	it("names the first substantive exchange through the active model without blocking prompt settlement", async () => {
		let releaseTitleResponse: (() => void) | undefined;
		const titleResponseReleased = new Promise<void>((resolve) => {
			releaseTitleResponse = resolve;
		});
		let titleModelId: string | undefined;
		const harness = await createSessionAutonameHarness({ persistedSession: true });
		harnesses.push(harness);
		routeMainAndTitleResponses(harness, [
			completedAssistantMessage("Session autonaming can run after the first completed exchange."),
			async (_context, _options, _state, model) => {
				titleModelId = model.id;
				await titleResponseReleased;
				return fauxAssistantMessage('\n### "Automatic Session Naming"\n');
			},
		]);

		const prompt = harness.session.prompt("Can we autoname sessions?");
		const titleRequestStarted = await waitUntil(() => harness.faux.state.callCount === 2);
		if (!titleRequestStarted) releaseTitleResponse?.();
		expect(titleRequestStarted).toBe(true);

		const promptSettledBeforeTitle = await Promise.race([
			prompt.then(() => true),
			delay(PROMPT_SETTLEMENT_TIMEOUT_MS).then(() => false),
		]);
		try {
			expect(promptSettledBeforeTitle).toBe(true);
		} finally {
			releaseTitleResponse?.();
		}

		await prompt;
		expect(await waitUntil(() => harness.sessionManager.getSessionName() !== undefined)).toBe(true);
		expect(harness.sessionManager.getSessionName()).toBe("Automatic Session Naming");
		expect(titleModelId).toBe(harness.getModel().id);
		expect(harness.eventsOfType("session_info_changed").map((event) => event.name)).toEqual([
			"Automatic Session Naming",
		]);
		const sessionFile = harness.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		expect(readSessionMetadata(getControlDbPath(harness.tempDir), sessionFile ?? "")?.name).toBe(
			"Automatic Session Naming",
		);
	});

	it("names persisted sessions in RPC mode", async () => {
		const harness = await createSessionAutonameHarness({ mode: "rpc", persistedSession: true });
		harnesses.push(harness);
		routeMainAndTitleResponses(harness, [
			completedAssistantMessage("Substantive RPC answer."),
			fauxAssistantMessage("RPC Session Autonaming"),
		]);

		await harness.session.prompt("Name this RPC session.", { source: "rpc" });
		expect(await waitUntil(() => harness.sessionManager.getSessionName() !== undefined)).toBe(true);
		expect(harness.sessionManager.getSessionName()).toBe("RPC Session Autonaming");
	});

	it.each(["print", "json"] as const)("does not launch background autonaming in %s mode", async (mode) => {
		const harness = await createSessionAutonameHarness({ mode, persistedSession: true });
		harnesses.push(harness);
		routeMainAndTitleResponses(harness, [
			completedAssistantMessage("Substantive answer."),
			fauxAssistantMessage("One Shot Session Should Not Be Named"),
		]);

		await harness.session.prompt("Explain one-shot mode behavior.");
		await delay(BACKGROUND_SETTLEMENT_DELAY_MS);

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
	});

	it("does not name an ephemeral session", async () => {
		const harness = await createSessionAutonameHarness();
		harnesses.push(harness);
		routeMainAndTitleResponses(harness, [
			completedAssistantMessage("Substantive answer."),
			fauxAssistantMessage("Ephemeral Session Should Not Be Named"),
		]);

		await harness.session.prompt("Explain the persistence boundary.");
		await delay(BACKGROUND_SETTLEMENT_DELAY_MS);

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
	});

	it("does not name a child-agent runtime", async () => {
		const harness = await createSessionAutonameHarness({
			persistedSession: true,
			multiAgentRuntimeRole: "child",
			multiAgentAgentId: "child-agent",
		});
		harnesses.push(harness);
		routeMainAndTitleResponses(harness, [
			completedAssistantMessage("Substantive child answer."),
			fauxAssistantMessage("Child Session Should Not Be Named"),
		]);

		await harness.session.prompt("Complete the delegated task.");
		await delay(BACKGROUND_SETTLEMENT_DELAY_MS);

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
	});

	it("does not name from extension-only activity after a historical real-user turn", async () => {
		const harness = await createSessionAutonameHarness({ persistedSession: true });
		harnesses.push(harness);
		const historicalUserMessage = {
			role: "user" as const,
			content: "Historical real-user request.",
			inputSource: "interactive" as const,
			timestamp: Date.now(),
		};
		const historicalAssistantMessage = completedAssistantMessage("Historical response.");
		const extensionUserMessage = {
			role: "user" as const,
			content: "Extension continuation.",
			inputSource: "extension" as const,
			timestamp: Date.now() + 1,
		};
		const extensionAssistantMessage = completedAssistantMessage("Extension response.");
		harness.sessionManager.appendMessage(historicalUserMessage);
		harness.sessionManager.appendMessage(historicalAssistantMessage);
		harness.sessionManager.appendMessage(extensionUserMessage);
		harness.sessionManager.appendMessage(extensionAssistantMessage);
		harness.setResponses([fauxAssistantMessage("Incorrect Historical Name")]);

		await harness.session.extensionRunner.emit({ type: "message_start", message: extensionUserMessage });
		await harness.session.extensionRunner.emit({ type: "message_start", message: extensionAssistantMessage });
		await delay(BACKGROUND_SETTLEMENT_DELAY_MS);

		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
	});

	it("allows the first real user prompt after extension-only activity to name the session", async () => {
		const harness = await createSessionAutonameHarness({ persistedSession: true });
		harnesses.push(harness);
		routeMainAndTitleResponses(harness, [
			completedAssistantMessage("Internal extension response."),
			completedAssistantMessage("Response to the first real user prompt."),
			fauxAssistantMessage("Real User Session"),
		]);

		await harness.session.prompt("Internal continuation.", { source: "extension" });
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getSessionName()).toBeUndefined();

		await harness.session.prompt("First real request.");
		expect(await waitUntil(() => harness.sessionManager.getSessionName() !== undefined)).toBe(true);
		expect(harness.sessionManager.getSessionName()).toBe("Real User Session");
	});

	it("ignores historical JSONL session info when metadata has never stored a name", async () => {
		const harness = await createSessionAutonameHarness({ persistedSession: true });
		harnesses.push(harness);
		const sessionFile = harness.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		harness.sessionManager.persistForRecovery();
		appendFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "session_info",
				id: "legacy-session-name",
				parentId: null,
				timestamp: "2025-01-01T00:00:00.000Z",
				name: "Historical JSONL Name",
			})}\n`,
		);
		harness.sessionManager.setSessionFile(sessionFile);
		routeMainAndTitleResponses(harness, [
			completedAssistantMessage("Current response."),
			fauxAssistantMessage("Metadata Authority Name"),
		]);

		await harness.session.prompt("Current real-user request.");

		expect(await waitUntil(() => harness.sessionManager.getSessionName() !== undefined)).toBe(true);
		expect(harness.sessionManager.getSessionName()).toBe("Metadata Authority Name");
	});

	it("preserves an explicit clear before the first exchange", async () => {
		const harness = await createSessionAutonameHarness({ persistedSession: true });
		harnesses.push(harness);
		harness.session.clearSessionName();
		routeMainAndTitleResponses(harness, [
			completedAssistantMessage("Substantive answer."),
			fauxAssistantMessage("Generated Name Should Not Replace Clear"),
		]);

		await harness.session.prompt("Keep this session unnamed.");
		await delay(BACKGROUND_SETTLEMENT_DELAY_MS);

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
		expect(harness.sessionManager.hasSessionNameState()).toBe(true);
	});

	it("preserves a session name set before the first exchange", async () => {
		const harness = await createSessionAutonameHarness({ persistedSession: true });
		harnesses.push(harness);
		harness.session.setSessionName("Manual Session Name");
		routeMainAndTitleResponses(harness, [
			completedAssistantMessage("Substantive answer."),
			fauxAssistantMessage("Generated Name Should Not Replace Manual Name"),
		]);

		await harness.session.prompt("Keep my manual name.");
		await delay(BACKGROUND_SETTLEMENT_DELAY_MS);

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getSessionName()).toBe("Manual Session Name");
	});

	it.each([
		{ firstResponse: emptyCompletedAssistantMessage(), label: "empty" },
		{ firstResponse: failedAssistantMessage(), label: "failed" },
	])("names the session from the user prompt when the first response is $label", async ({ firstResponse }) => {
		const harness = await createSessionAutonameHarness({
			persistedSession: true,
			settings: { retry: { enabled: false } },
		});
		harnesses.push(harness);
		routeMainAndTitleResponses(harness, [firstResponse, fauxAssistantMessage("Named From User Prompt")]);

		await harness.session.prompt("First exchange.");

		expect(await waitUntil(() => harness.sessionManager.getSessionName() !== undefined)).toBe(true);
		expect(harness.sessionManager.getSessionName()).toBe("Named From User Prompt");
	});

	it("names from a real user message before it is appended to the branch", async () => {
		const harness = await createSessionAutonameHarness({ persistedSession: true });
		harnesses.push(harness);
		const userMessage = {
			role: "user" as const,
			content: "Attempt work that ultimately fails.",
			inputSource: "interactive" as const,
			timestamp: Date.now(),
		};
		harness.setResponses([fauxAssistantMessage("Failed Work Session")]);

		await harness.session.extensionRunner.emit({ type: "message_start", message: userMessage });

		expect(await waitUntil(() => harness.sessionManager.getSessionName() !== undefined)).toBe(true);
		expect(harness.sessionManager.getSessionName()).toBe("Failed Work Session");
	});

	it("names a session whose first response was aborted before a second user message", async () => {
		const harness = await createSessionAutonameHarness({ persistedSession: true });
		harnesses.push(harness);
		const firstUserMessage = {
			role: "user" as const,
			content: "Why is the footer missing the session name?",
			inputSource: "interactive" as const,
			timestamp: Date.now(),
		};
		const abortedAssistant = fauxAssistantMessage("", { stopReason: "aborted" });
		const secondUserMessage = {
			role: "user" as const,
			content: "Tell me more.",
			inputSource: "interactive" as const,
			timestamp: Date.now() + 1,
		};
		harness.sessionManager.appendMessage(firstUserMessage);
		harness.sessionManager.appendMessage(abortedAssistant);
		harness.sessionManager.appendMessage(secondUserMessage);
		harness.setResponses([fauxAssistantMessage("Footer Name Bug")]);

		await harness.session.extensionRunner.emit({ type: "message_start", message: secondUserMessage });

		expect(await waitUntil(() => harness.sessionManager.getSessionName() !== undefined)).toBe(true);
		expect(harness.sessionManager.getSessionName()).toBe("Footer Name Bug");
	});

	it("does not start autonaming from cwd-relocation or terminal agent_end events", async () => {
		const harness = await createSessionAutonameHarness({ persistedSession: true });
		harnesses.push(harness);
		const userMessage = {
			role: "user" as const,
			content: "Move to the project and continue.",
			inputSource: "interactive" as const,
			timestamp: Date.now(),
		};
		const assistantMessage = completedAssistantMessage("Relocation started.");
		harness.sessionManager.appendMessage(userMessage);
		harness.sessionManager.appendMessage(assistantMessage);
		harness.setResponses([fauxAssistantMessage("Relocated Project Work")]);

		await harness.session.extensionRunner.emit({
			type: "agent_end",
			messages: [userMessage, assistantMessage],
			sessionContinuation: "cwd_relocation",
		});
		await delay(BACKGROUND_SETTLEMENT_DELAY_MS);
		expect(harness.faux.state.callCount).toBe(0);

		await harness.session.extensionRunner.emit({ type: "agent_end", messages: [] });
		await delay(BACKGROUND_SETTLEMENT_DELAY_MS);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
	});

	it("leaves the session unnamed when title generation fails", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const harness = await createSessionAutonameHarness({ persistedSession: true });
		harnesses.push(harness);
		routeMainAndTitleResponses(harness, [
			completedAssistantMessage("Substantive answer."),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" }),
		]);

		try {
			await harness.session.prompt("Start a title request that fails.");
			expect(await waitUntil(() => consoleError.mock.calls.length > 0)).toBe(true);
			expect(harness.sessionManager.getSessionName()).toBeUndefined();
			expect(consoleError).toHaveBeenCalledWith("Session autoname failed: invalid_api_key");
		} finally {
			consoleError.mockRestore();
		}
	});

	it("cancels pending autonaming when the session shuts down", async () => {
		let releaseTitleResponse: (() => void) | undefined;
		const titleResponseReleased = new Promise<void>((resolve) => {
			releaseTitleResponse = resolve;
		});
		const harness = await createSessionAutonameHarness({ persistedSession: true });
		harnesses.push(harness);
		routeMainAndTitleResponses(harness, [
			completedAssistantMessage("Substantive answer."),
			async () => {
				await titleResponseReleased;
				return fauxAssistantMessage("Stale Session Name");
			},
		]);

		const prompt = harness.session.prompt("Start title generation before shutdown.");
		expect(await waitUntil(() => harness.faux.state.callCount === 2)).toBe(true);
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
		releaseTitleResponse?.();
		await prompt;
		await delay(BACKGROUND_SETTLEMENT_DELAY_MS);

		expect(harness.sessionManager.getSessionName()).toBeUndefined();
	});

	it("lets a manual clear while title generation is pending win", async () => {
		let releaseTitleResponse: (() => void) | undefined;
		const titleResponseReleased = new Promise<void>((resolve) => {
			releaseTitleResponse = resolve;
		});
		const harness = await createSessionAutonameHarness({ persistedSession: true });
		harnesses.push(harness);
		routeMainAndTitleResponses(harness, [
			completedAssistantMessage("Substantive answer."),
			async () => {
				await titleResponseReleased;
				return fauxAssistantMessage("Generated Session Name");
			},
		]);

		const prompt = harness.session.prompt("Start title generation before clearing the name.");
		const titleRequestStarted = await waitUntil(() => harness.faux.state.callCount === 2);
		if (!titleRequestStarted) releaseTitleResponse?.();
		expect(titleRequestStarted).toBe(true);

		harness.session.clearSessionName();
		releaseTitleResponse?.();
		await prompt;
		await delay(BACKGROUND_SETTLEMENT_DELAY_MS);

		expect(harness.sessionManager.getSessionName()).toBeUndefined();
		expect(harness.eventsOfType("session_info_changed").map((event) => event.name)).toEqual([undefined]);
	});

	it("lets a manual name set while title generation is pending win", async () => {
		let releaseTitleResponse: (() => void) | undefined;
		const titleResponseReleased = new Promise<void>((resolve) => {
			releaseTitleResponse = resolve;
		});
		const harness = await createSessionAutonameHarness({ persistedSession: true });
		harnesses.push(harness);
		routeMainAndTitleResponses(harness, [
			completedAssistantMessage("Substantive answer."),
			async () => {
				await titleResponseReleased;
				return fauxAssistantMessage("Generated Session Name");
			},
		]);

		const prompt = harness.session.prompt("Start title generation.");
		const titleRequestStarted = await waitUntil(() => harness.faux.state.callCount === 2);
		if (!titleRequestStarted) releaseTitleResponse?.();
		expect(titleRequestStarted).toBe(true);

		harness.session.setSessionName("Manual Name During Generation");
		releaseTitleResponse?.();
		await prompt;
		await delay(BACKGROUND_SETTLEMENT_DELAY_MS);

		expect(harness.sessionManager.getSessionName()).toBe("Manual Name During Generation");
	});
});
