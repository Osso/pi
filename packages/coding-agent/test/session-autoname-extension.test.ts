import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import sessionAutonameExtension from "../extensions/session-autoname/src/index.ts";
import type { ExtensionMode } from "../src/core/extensions/types.ts";
import { getControlDbPath, readSessionMetadata } from "../src/core/session-control-db.ts";
import { createHarness, type Harness, type HarnessOptions } from "./suite/harness.ts";

const ASYNC_SETTLEMENT_TIMEOUT_MS = 1_000;
const BACKGROUND_SETTLEMENT_DELAY_MS = 50;
const PROMPT_SETTLEMENT_TIMEOUT_MS = 500;

async function waitUntil(predicate: () => boolean, timeoutMs = ASYNC_SETTLEMENT_TIMEOUT_MS): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) {
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

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("names the first substantive exchange through the active model without blocking prompt settlement", async () => {
		let releaseTitleResponse: (() => void) | undefined;
		const titleResponseReleased = new Promise<void>((resolve) => {
			releaseTitleResponse = resolve;
		});
		let titleModelId: string | undefined;
		const harness = await createSessionAutonameHarness({ persistedSession: true });
		harnesses.push(harness);
		harness.setResponses([
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
		harness.setResponses([
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
		harness.setResponses([
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
		harness.setResponses([
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
		harness.setResponses([
			completedAssistantMessage("Substantive child answer."),
			fauxAssistantMessage("Child Session Should Not Be Named"),
		]);

		await harness.session.prompt("Complete the delegated task.");
		await delay(BACKGROUND_SETTLEMENT_DELAY_MS);

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
	});

	it("allows the first real user prompt after extension-only activity to name the session", async () => {
		const harness = await createSessionAutonameHarness({ persistedSession: true });
		harnesses.push(harness);
		harness.setResponses([
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

	it("preserves a session name set before the first exchange", async () => {
		const harness = await createSessionAutonameHarness({ persistedSession: true });
		harnesses.push(harness);
		harness.session.setSessionName("Manual Session Name");
		harness.setResponses([
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
	])("never names later turns after a $label first exchange", async ({ firstResponse }) => {
		const harness = await createSessionAutonameHarness({
			persistedSession: true,
			settings: { retry: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([
			firstResponse,
			completedAssistantMessage("A later substantive answer."),
			fauxAssistantMessage("Later Turn Should Not Name Session"),
		]);

		await harness.session.prompt("First exchange.");
		await harness.session.prompt("Second exchange.");
		await delay(BACKGROUND_SETTLEMENT_DELAY_MS);

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
	});

	it("does not name from earlier assistant text when the exchange ends in failure", async () => {
		const harness = await createSessionAutonameHarness({ persistedSession: true });
		harnesses.push(harness);
		const userMessage = {
			role: "user" as const,
			content: "Attempt work that ultimately fails.",
			inputSource: "interactive" as const,
			timestamp: Date.now(),
		};
		const partialAssistantMessage = completedAssistantMessage("Partial progress before failure.");
		const finalFailure = failedAssistantMessage();
		harness.sessionManager.appendMessage(userMessage);
		harness.sessionManager.appendMessage(partialAssistantMessage);
		harness.sessionManager.appendMessage(finalFailure);
		harness.setResponses([fauxAssistantMessage("Failed Work Session")]);

		await harness.session.extensionRunner.emit({
			type: "agent_end",
			messages: [userMessage, partialAssistantMessage, finalFailure],
		});
		await delay(BACKGROUND_SETTLEMENT_DELAY_MS);

		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
	});

	it("does not treat a later root branch as the session's first exchange", async () => {
		const harness = await createSessionAutonameHarness({ persistedSession: true });
		harnesses.push(harness);
		harness.setResponses([
			emptyCompletedAssistantMessage(),
			completedAssistantMessage("Substantive answer on a later root branch."),
			fauxAssistantMessage("Later Branch Session"),
		]);

		await harness.session.prompt("Original first exchange.");
		harness.sessionManager.resetLeaf();
		await harness.session.prompt("Later root branch exchange.");
		await delay(BACKGROUND_SETTLEMENT_DELAY_MS);

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
	});

	it("defers autonaming across a cwd-relocation continuation", async () => {
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
		expect(await waitUntil(() => harness.sessionManager.getSessionName() !== undefined)).toBe(true);
		expect(harness.sessionManager.getSessionName()).toBe("Relocated Project Work");
	});

	it("leaves the session unnamed when title generation fails", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const harness = await createSessionAutonameHarness({ persistedSession: true });
		harnesses.push(harness);
		harness.setResponses([
			completedAssistantMessage("Substantive answer."),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "title service unavailable" }),
		]);

		try {
			await harness.session.prompt("Start a title request that fails.");
			expect(await waitUntil(() => consoleError.mock.calls.length > 0)).toBe(true);
			expect(harness.sessionManager.getSessionName()).toBeUndefined();
			expect(consoleError).toHaveBeenCalledWith("Session autoname failed: title service unavailable");
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
		harness.setResponses([
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
		harness.setResponses([
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
		harness.setResponses([
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
