import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import remindersExtension from "../../extensions/reminders/src/index.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { listReminders } from "../../src/core/reminder-store.ts";
import { getControlDbPath } from "../../src/core/session-control-db.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const temporaryDirectories: string[] = [];
const now = new Date("2026-10-25T12:00:00Z");

interface OpenOptions {
	deliver?: boolean;
	notifications?: string[][];
}

async function openReminders(controlDbPath: string, options: OpenOptions = {}): Promise<Harness> {
	const notifications = options.notifications ?? [];
	const harness = await createHarness({
		extensionFactories: [
			(pi: ExtensionAPI) =>
				remindersExtension(pi, {
					controlDbPath,
					now: () => now,
					deliveryIntervalMs: 20,
					notify: (title, body) => notifications.push([title, body]),
				}),
		],
	});
	harnesses.push(harness);
	if (options.deliver) {
		harness.settingsManager.applyOverrides({
			reminders: { deliverySessionId: harness.session.sessionManager.getSessionId() },
		});
	}
	harness.setResponses([fauxAssistantMessage("Noted.")]);
	await harness.session.bindExtensions({ mode: "rpc" });
	return harness;
}

function isolatedControlDb(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-reminders-suite-"));
	temporaryDirectories.push(directory);
	return getControlDbPath(directory);
}

async function invokeReminder(harness: Harness, args: Record<string, unknown>) {
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("reminders", args)], { stopReason: "toolUse" }),
		fauxAssistantMessage("Finished."),
	]);
	await harness.session.prompt("Use the reminder operation.");
	const result = harness.session.messages.filter((message) => message.role === "toolResult").at(-1);
	if (!result || result.role !== "toolResult") throw new Error("No reminder tool result");
	return result;
}

async function runReminderTool(harness: Harness, args: Record<string, unknown>): Promise<string> {
	const result = await invokeReminder(harness, args);
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function deliveredTexts(harness: Harness): string[] {
	return harness.session.messages.flatMap((message) =>
		message.role === "custom" && message.customType === "reminder" && typeof message.content === "string"
			? [message.content]
			: [],
	);
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("persistent reminders", () => {
	it("makes a reminder created in one project visible and editable in another session", async () => {
		const path = isolatedControlDb();
		const first = await openReminders(path);
		const added = await runReminderTool(first, {
			action: "add",
			title: "Recheck security advisories",
			dueAt: "2026-10-26T09:00:00-05:00",
			notes: "Review new disclosures; do not start remediation automatically.",
			projectPath: "/projects/security",
		});
		expect(added).toContain("Recheck security advisories");
		expect(added).toMatch(/#\d+/);
		expect(added).toContain("2026-10-26");
		const id = Number(/#(\d+)/.exec(added)?.[1]);
		const second = await openReminders(path);
		expect(second.tempDir).not.toBe(first.tempDir);
		expect(await runReminderTool(second, { action: "list" })).toContain("/projects/security");
		await runReminderTool(second, {
			action: "edit",
			id,
			title: "Recheck vendor advisories",
			notes: "Use primary sources",
		});
		await runReminderTool(second, { action: "reschedule", id, dueAt: "2026-10-27T09:00:00-05:00" });
		const listing = await runReminderTool(first, { action: "list" });
		expect(listing).toContain("Recheck vendor advisories");
		expect(listing).toContain("Use primary sources");
		expect(listing).toContain("2026-10-27");
		await runReminderTool(first, { action: "complete", id });
		expect(await runReminderTool(second, { action: "list" })).not.toContain("Recheck vendor advisories");
		expect(await runReminderTool(second, { action: "list", status: "done" })).toContain("Recheck vendor advisories");
		await runReminderTool(second, { action: "reschedule", id, dueAt: "2026-10-28T09:00:00-05:00" });
		expect(await runReminderTool(first, { action: "list", status: "done" })).toContain("Recheck vendor advisories");
		await runReminderTool(first, { action: "reopen", id });
		expect(await runReminderTool(second, { action: "list" })).toContain("Recheck vendor advisories");
		await runReminderTool(second, { action: "delete", id });
		expect(await runReminderTool(first, { action: "list", status: "all" })).not.toContain(
			"Recheck vendor advisories",
		);
	});

	it("tells agents that reminders are follow-ups, not plans or authorization", async () => {
		const harness = await openReminders(isolatedControlDb());
		let systemPrompt = "";
		harness.setResponses([
			(context) => {
				systemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("Ready.");
			},
		]);
		await harness.session.prompt("What can you track?");
		expect(systemPrompt).toContain("PLAN.md");
		expect(systemPrompt).toContain("not authorization");
		expect(systemPrompt).toMatch(/without being asked/);
		expect(systemPrompt).toMatch(/ID and due time/);
	});

	it("reports invalid due times and unknown ids without saving a reminder", async () => {
		const harness = await openReminders(isolatedControlDb());
		const invalid = await invokeReminder(harness, { action: "add", title: "Invalid", dueAt: "tomorrow" });
		expect(invalid.isError).toBe(true);
		const unknown = await invokeReminder(harness, { action: "complete", id: 999 });
		expect(unknown.isError).toBe(true);
		expect(await runReminderTool(harness, { action: "list" })).not.toContain("Invalid");
	});
});

describe("reminder delivery", () => {
	it("delivers each due open reminder once, only in the configured delivery session", async () => {
		const path = isolatedControlDb();
		const writer = await openReminders(path);
		await runReminderTool(writer, { action: "add", title: "Old advisory recheck", dueAt: "2026-10-20T09:00:00Z" });
		await runReminderTool(writer, { action: "add", title: "Future follow-up", dueAt: "2026-11-20T09:00:00Z" });
		const assistantNotifications: string[][] = [];
		const otherNotifications: string[][] = [];
		const other = await openReminders(path, { notifications: otherNotifications });
		const assistant = await openReminders(path, { deliver: true, notifications: assistantNotifications });

		await waitFor(() => deliveredTexts(assistant).length > 0);
		await new Promise((resolve) => setTimeout(resolve, 100));
		const delivered = deliveredTexts(assistant);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toContain("Old advisory recheck");
		expect(delivered[0]).toContain("not authorization");
		expect(delivered[0]).not.toContain("Future follow-up");
		expect(assistantNotifications).toEqual([["Pi reminder", expect.stringContaining("Old advisory recheck")]]);

		expect(deliveredTexts(other)).toEqual([]);
		expect(deliveredTexts(writer)).toEqual([]);
		expect(otherNotifications).toEqual([]);
		await waitFor(() => assistant.eventsOfType("agent_start").length > 0);
		expect(other.eventsOfType("agent_start")).toHaveLength(0);
		const [stored] = listReminders(path).filter((reminder) => reminder.title === "Old advisory recheck");
		expect(stored.status).toBe("open");
		expect(stored.deliveredAt).toBe(now.toISOString());
	});
});

describe("/reminders command", () => {
	it("adds, completes and reopens reminders in the shared list from user commands", async () => {
		const path = isolatedControlDb();
		const harness = await openReminders(path);
		await harness.session.prompt("/reminders add 2026-10-26 09:00 Recheck security advisories");
		const [added] = listReminders(path);
		expect(added).toMatchObject({ title: "Recheck security advisories", status: "open" });
		expect(new Date(added.dueAt).getTime()).toBe(new Date(2026, 9, 26, 9, 0).getTime());
		await harness.session.prompt(`/reminders done ${added.id}`);
		expect(listReminders(path)).toEqual([]);
		await harness.session.prompt(`/reminders reopen ${added.id}`);
		expect(listReminders(path).map((reminder) => reminder.id)).toEqual([added.id]);
		expect(harness.faux.state.callCount).toBe(0);
	});
});
