import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type PendingMessagesDisplayThis = {
	compactionQueuedMessages: [];
	getAllQueuedMessages(): { steering: string[]; followUp: string[] };
	getAppKeyDisplay(): string;
	pendingMessagesContainer: Container;
};

type UpdatePendingMessagesDisplay = (this: PendingMessagesDisplayThis) => void;

const updatePendingMessagesDisplay = (
	InteractiveMode.prototype as unknown as { updatePendingMessagesDisplay: UpdatePendingMessagesDisplay }
).updatePendingMessagesDisplay;

describe("InteractiveMode follow-up preview", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("shows agent sender and first body line in a compact preview", () => {
		const message = [
			"From:",
			"- agent: agent_1",
			"",
			"Message:",
			"This body line is deliberately longer than fifty characters for truncation.",
			"Second body line is hidden.",
		].join("\n");
		const fakeThis: PendingMessagesDisplayThis = {
			compactionQueuedMessages: [],
			getAllQueuedMessages: () => ({ steering: [], followUp: [message] }),
			getAppKeyDisplay: () => "ctrl+d",
			pendingMessagesContainer: new Container(),
		};

		updatePendingMessagesDisplay.call(fakeThis);

		const rendered = fakeThis.pendingMessagesContainer.render(120).join("\n");
		expect(rendered).toContain("Follow-up from agent_1: This body line is deliberately longer than fifty c…");
		expect(rendered).not.toContain("Second body line");
	});

	test("does not add an ellipsis to a fifty-character body line", () => {
		const body = "12345678901234567890123456789012345678901234567890";
		const message = ["From:", "- agent: agent_1", "", "Message:", body].join("\n");
		const fakeThis: PendingMessagesDisplayThis = {
			compactionQueuedMessages: [],
			getAllQueuedMessages: () => ({ steering: [], followUp: [message] }),
			getAppKeyDisplay: () => "ctrl+d",
			pendingMessagesContainer: new Container(),
		};

		updatePendingMessagesDisplay.call(fakeThis);

		const rendered = fakeThis.pendingMessagesContainer.render(120).join("\n");
		expect(rendered).toContain(`Follow-up from agent_1: ${body}`);
		expect(rendered).not.toContain(`${body}…`);
	});

	test("identifies an unknown sender when a follow-up has no sender metadata", () => {
		const fakeThis: PendingMessagesDisplayThis = {
			compactionQueuedMessages: [],
			getAllQueuedMessages: () => ({ steering: [], followUp: ["Plain queued follow-up"] }),
			getAppKeyDisplay: () => "ctrl+d",
			pendingMessagesContainer: new Container(),
		};

		updatePendingMessagesDisplay.call(fakeThis);

		const rendered = fakeThis.pendingMessagesContainer.render(120).join("\n");
		expect(rendered).toContain("Follow-up from unknown: Plain queued follow-up");
	});

	test("shows shared-channel sender in the same compact preview", () => {
		const message = [
			"From shared channel:",
			"- session: main-session",
			"- agent: main",
			"",
			"Message:",
			"Release path changed.",
		].join("\n");
		const fakeThis: PendingMessagesDisplayThis = {
			compactionQueuedMessages: [],
			getAllQueuedMessages: () => ({ steering: [], followUp: [message] }),
			getAppKeyDisplay: () => "ctrl+d",
			pendingMessagesContainer: new Container(),
		};

		updatePendingMessagesDisplay.call(fakeThis);

		const rendered = fakeThis.pendingMessagesContainer.render(120).join("\n");
		expect(rendered).toContain("Follow-up from main: Release path changed.");
	});
});
