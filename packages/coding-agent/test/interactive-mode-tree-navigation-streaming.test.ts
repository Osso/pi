import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Component } from "../../tui/src/tui.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

const showTreeSelector = (InteractiveMode.prototype as unknown as Record<string, unknown>).showTreeSelector as (
	this: unknown,
	initialSelectedId?: string,
	filterMode?: string,
) => void;

// Upstream #7022: navigation rejects while a response streams, so /tree stops the response once the user commits.
describe("interactive /tree during a response", () => {
	let harness: Harness | undefined;

	beforeAll(() => initTheme("dark"));
	afterEach(() => harness?.cleanup());

	it("aborts the streaming response and then navigates to the selected entry", async () => {
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
		harness.setResponses([
			async (_context, options) => {
				markStreaming();
				await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve()));
				return fauxAssistantMessage("never finished");
			},
		]);
		const prompt = harness.session.prompt("PROBE-7022");
		await streaming;

		let selector: Component | undefined;
		const showError = vi.fn();
		const showTreeNavigationResult = vi.fn();
		const mode = {
			session: harness.session,
			sessionManager: harness.sessionManager,
			settingsManager: { getTreeFilterMode: () => "all", getBranchSummarySkipPrompt: () => true },
			ui: { terminal: { rows: 40 }, requestRender: () => {} },
			defaultEditor: {},
			showSelector: (create: (done: () => void) => { component: Component }) => {
				selector = create(() => {}).component;
			},
			restoreQueuedMessagesToEditor: () => 0,
			showStatus: vi.fn(),
			showError,
			showTreeNavigationResult,
		};

		showTreeSelector.call(mode, targetId, "all");
		selector?.handleInput?.("\r");
		await vi.waitFor(() => expect(showTreeNavigationResult).toHaveBeenCalled());
		await prompt;

		expect(showError).not.toHaveBeenCalled();
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.sessionManager.getLeafId()).toBe(targetId);
	});
});
