import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import remindersExtension from "../../extensions/reminders/src/index.ts";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import type { ExtensionAPI, ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { listReminders } from "../../src/core/reminder-store.ts";
import { getControlDbPath } from "../../src/core/session-control-db.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const temporaryDirectories: string[] = [];
const now = new Date("2026-10-25T12:00:00Z");

interface OpenOptions {
	deliver?: boolean;
	notifications?: string[][];
	uiMessages?: string[];
	now?: () => Date;
}

/** UI context that records notify() text; other UI calls are inert. */
function recordingUi(messages: string[]): ExtensionUIContext {
	const notify = (message: string) => messages.push(message);
	return new Proxy({ notify } as unknown as ExtensionUIContext, {
		get: (target, key) => (key in target ? target[key as keyof ExtensionUIContext] : () => undefined),
	});
}

async function openReminders(controlDbPath: string, options: OpenOptions = {}): Promise<Harness> {
	const notifications = options.notifications ?? [];
	const harness = await createHarness({
		extensionFactories: [
			(pi: ExtensionAPI) =>
				remindersExtension(pi, {
					controlDbPath,
					now: options.now ?? (() => now),
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
	await harness.session.bindExtensions({
		mode: "rpc",
		...(options.uiMessages ? { uiContext: recordingUi(options.uiMessages) } : {}),
	});
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

/** A turn that stays busy until the session aborts it. */
function busyUntilAborted(harness: Harness): void {
	harness.setResponses([
		(_context, options) =>
			new Promise((resolve) => {
				options?.signal?.addEventListener("abort", () =>
					resolve(fauxAssistantMessage("Stopped.", { stopReason: "aborted" })),
				);
			}),
		fauxAssistantMessage("Noted."),
	]);
}

/** Stop a session the way process exit does: no further delivery checks, nothing queued survives. */
async function exitSession(harness: Harness): Promise<void> {
	await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
	harnesses.splice(harnesses.indexOf(harness), 1);
	harness.cleanup();
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
		await waitFor(() => assistant.eventsOfType("agent_end").length > 0);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(assistant.eventsOfType("agent_start")).toHaveLength(1);
		expect(other.eventsOfType("agent_start")).toHaveLength(0);
		const [stored] = listReminders(path).filter((reminder) => reminder.title === "Old advisory recheck");
		expect(stored.status).toBe("open");
		expect(stored.deliveredAt).toBe(now.toISOString());

		assistant.setResponses([fauxAssistantMessage("Noted again.")]);
		await runReminderTool(writer, { action: "reschedule", id: stored.id, dueAt: "2026-10-24T09:00:00Z" });
		await waitFor(() => deliveredTexts(assistant).length > 1);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(deliveredTexts(assistant)).toHaveLength(2);
		expect(assistantNotifications).toHaveLength(2);
	});
});

describe("reminder delivery acknowledgement", () => {
	const dueAt = "2026-10-25T12:30:00Z";
	const afterDue = new Date("2026-10-25T13:00:00Z");

	async function busyAssistantWithQueuedReminder(path: string, alerts: string[][]) {
		let clock = now;
		const assistant = await openReminders(path, { deliver: true, notifications: alerts, now: () => clock });
		busyUntilAborted(assistant);
		const turn = assistant.session.prompt("Long task");
		await waitFor(() => assistant.session.isStreaming);
		clock = afterDue;
		await waitFor(() => alerts.length === 1);
		expect(listReminders(path)[0].deliveredAt).toBeUndefined();
		return { assistant, turn };
	}

	it("redelivers a reminder queued in a busy assistant that exits before writing it", async () => {
		const path = isolatedControlDb();
		const writer = await openReminders(path);
		await runReminderTool(writer, { action: "add", title: "Queued advisory recheck", dueAt });
		const { assistant } = await busyAssistantWithQueuedReminder(path, []);
		await exitSession(assistant);
		expect(listReminders(path)[0].deliveredAt).toBeUndefined();

		const restarted = await openReminders(path, { deliver: true, now: () => afterDue });
		await waitFor(() => listReminders(path)[0].deliveredAt !== undefined);
		expect(deliveredTexts(restarted)).toHaveLength(1);
		expect(deliveredTexts(restarted)[0]).toContain("Queued advisory recheck");
		expect(listReminders(path)[0].deliveredAt).toBe(afterDue.toISOString());
	});

	it("redelivers a reminder dropped from the queue when the busy turn is aborted", async () => {
		const path = isolatedControlDb();
		const writer = await openReminders(path);
		await runReminderTool(writer, { action: "add", title: "Aborted advisory recheck", dueAt });
		const alerts: string[][] = [];
		const { assistant, turn } = await busyAssistantWithQueuedReminder(path, alerts);
		await assistant.session.abort();
		await turn;
		expect(deliveredTexts(assistant)).toEqual([]);

		await waitFor(() => listReminders(path)[0].deliveredAt !== undefined);
		expect(deliveredTexts(assistant)).toHaveLength(1);
		expect(deliveredTexts(assistant)[0]).toContain("Aborted advisory recheck");
		expect(alerts).toHaveLength(2);
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

	it("lists, edits, reschedules and deletes reminders from user commands", async () => {
		const path = isolatedControlDb();
		const writer = await openReminders(path);
		await runReminderTool(writer, {
			action: "add",
			title: "Renew certificate",
			dueAt: "2026-10-30T09:00:00Z",
			projectPath: "/projects/infra",
		});
		await runReminderTool(writer, { action: "add", title: "Overdue backup check", dueAt: "2026-10-20T09:00:00Z" });
		await runReminderTool(writer, { action: "add", title: "Finished audit", dueAt: "2026-10-21T09:00:00Z" });
		const byTitle = (title: string) => listReminders(path, "all").find((reminder) => reminder.title === title)!;
		const [certificate, backup, audit] = ["Renew certificate", "Overdue backup check", "Finished audit"].map(byTitle);
		await runReminderTool(writer, { action: "complete", id: audit.id });
		const beforeListing = listReminders(path, "all");

		const uiMessages: string[] = [];
		const harness = await openReminders(path, { uiMessages });
		const command = async (args: string): Promise<string> => {
			await harness.session.prompt(`/reminders ${args}`.trimEnd());
			return uiMessages.at(-1) ?? "";
		};

		const open = await command("");
		expect(open).toContain("Renew certificate");
		expect(open).toContain("/projects/infra");
		expect(open).not.toContain("Finished audit");
		expect(await command("list done")).toContain("Finished audit");
		const due = await command("list due");
		expect(due).toContain("Overdue backup check");
		expect(due).not.toContain("Renew certificate");
		expect(due).not.toContain("Finished audit");
		expect(listReminders(path, "all")).toEqual(beforeListing);

		await command(`edit ${certificate.id} Renew TLS certificate`);
		await command(`notes ${certificate.id} Use the ACME client`);
		await command(`reschedule ${certificate.id} 2026-11-02T09:00:00Z`);
		const [edited] = listReminders(path).filter((reminder) => reminder.id === certificate.id);
		expect(edited).toMatchObject({
			title: "Renew TLS certificate",
			notes: "Use the ACME client",
			dueAt: "2026-11-02T09:00:00.000Z",
		});
		await command(`delete ${backup.id}`);
		expect(listReminders(path, "all").map((reminder) => reminder.id)).toEqual([audit.id, certificate.id]);
		expect(await command("delete")).toContain("Usage: /reminders");
		expect(harness.faux.state.callCount).toBe(0);
	});
});
