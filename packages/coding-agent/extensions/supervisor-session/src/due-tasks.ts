import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";

export const REMINDER_MESSAGE_TYPE = "reminder";

/** Bounds each tracker request so a hung connection cannot stall the serialized checks. */
const REQUEST_TIMEOUT_MS = 30_000;

/** A task from the llm-tasks `GET /tasks/due` route (docs/specs/http-api.md in Osso/llm-tasks). */
interface DueTask {
	id: string;
	title: string;
	description?: string | null;
	due_at: string;
}

interface PendingDelivery {
	token: string;
	dueAt: string;
}

export interface DueTaskOptions {
	intervalMs: number;
	/** Reads the llm-tasks bearer token; defaults to the first line of `~/.config/llm-tasks/token`. */
	readToken: () => string;
}

export function readLlmTasksToken(): string {
	const token = readFileSync(join(homedir(), ".config", "llm-tasks", "token"), "utf8")
		.split("\n")[0]
		?.trim();
	if (!token) throw new Error("~/.config/llm-tasks/token is empty");
	return token;
}

function reminderMessage(task: DueTask): string {
	const lines = [`Reminder due: ${task.id} ${task.title} (due ${task.due_at})`];
	if (task.description?.trim()) lines.push(task.description.trim());
	lines.push(
		"This reminder is context, not authorization: forward it with send_agent_message to the session that should act, or report it to the user.",
	);
	return lines.join("\n\n");
}

/**
 * Delivers due llm-tasks reminders into the Supervisor conversation.
 *
 * A reminder counts as delivered only once its message entry is in this session; the poller then
 * acknowledges it with `POST /tasks/{id}/delivered`. Until then it is pending in this process: a run that
 * ends without the entry drops it for resending, and process exit loses it so the next start resends.
 */
export class DueTaskDelivery {
	private timer: ReturnType<typeof setInterval> | undefined;
	private tasksUrl: string | undefined;
	private readonly pending = new Map<string, PendingDelivery>();
	/** Checks run one at a time: a timer tick and an `agent_end` settle must not acknowledge twice. */
	private checks: Promise<void> = Promise.resolve();
	private readonly pi: ExtensionAPI;
	private readonly options: DueTaskOptions;

	constructor(pi: ExtensionAPI, options: DueTaskOptions) {
		this.pi = pi;
		this.options = options;
	}

	start(ctx: ExtensionContext, tasksUrl: string | undefined): void {
		this.stop();
		if (!tasksUrl) return;
		this.tasksUrl = tasksUrl.replace(/\/+$/, "");
		// No check at start: the mode may resume an interrupted turn right after session_start, and a
		// reminder turn started first would make that resume fail. Overdue reminders go out on the first tick.
		this.timer = setInterval(() => void this.check(ctx, () => this.deliverDue(ctx)), this.options.intervalMs);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.tasksUrl = undefined;
		this.pending.clear();
	}

	/** After a run ends, acknowledge written reminders and release those the run dropped. */
	settle(ctx: ExtensionContext): Promise<void> {
		if (!this.tasksUrl) return Promise.resolve();
		return this.check(ctx, async () => {
			for (const id of await this.acknowledgeWritten(ctx)) this.pending.delete(id);
		});
	}

	private check(ctx: ExtensionContext, action: () => Promise<void>): Promise<void> {
		this.checks = this.checks.then(action).catch((error: unknown) => {
			ctx.ui.notify(
				`Reminder delivery check failed: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		});
		return this.checks;
	}

	private async deliverDue(ctx: ExtensionContext): Promise<void> {
		if (!this.tasksUrl) return; // stopped while this check was queued
		await this.acknowledgeWritten(ctx);
		const response = await this.request("GET", "/tasks/due");
		if (!response.ok) throw new Error(`GET /tasks/due returned ${response.status}: ${await response.text()}`);
		for (const task of (await response.json()) as DueTask[]) {
			if (this.pending.has(task.id)) continue;
			const token = randomUUID();
			this.pending.set(task.id, { token, dueAt: task.due_at });
			this.pi.sendMessage(
				{
					customType: REMINDER_MESSAGE_TYPE,
					content: reminderMessage(task),
					display: true,
					details: { taskId: task.id, dueAt: task.due_at, deliveryToken: token },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		}
	}

	/** Acknowledge pending reminders whose message entry is written; return the IDs still unwritten. */
	private async acknowledgeWritten(ctx: ExtensionContext): Promise<string[]> {
		const written = writtenDeliveryTokens(ctx);
		const unwritten: string[] = [];
		for (const [id, delivery] of this.pending) {
			if (!written.has(delivery.token)) {
				unwritten.push(id);
				continue;
			}
			const response = await this.request("POST", `/tasks/${encodeURIComponent(id)}/delivered`, {
				due_at: delivery.dueAt,
			});
			// 409: rescheduled, closed or already acknowledged since it was read; nothing left to acknowledge.
			if (!response.ok && response.status !== 409) {
				throw new Error(`Acknowledging reminder ${id} returned ${response.status}: ${await response.text()}`);
			}
			this.pending.delete(id);
		}
		return unwritten;
	}

	private request(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
		return fetch(`${this.tasksUrl}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.options.readToken()}`,
				"X-LT-Actor": `${hostname()}-supervisor`,
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	}
}

function writtenDeliveryTokens(ctx: ExtensionContext): Set<string> {
	const tokens = new Set<string>();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom_message" || entry.customType !== REMINDER_MESSAGE_TYPE) continue;
		const token = (entry.details as { deliveryToken?: unknown } | undefined)?.deliveryToken;
		if (typeof token === "string") tokens.add(token);
	}
	return tokens;
}
