import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { REMINDER_MESSAGE_TYPE } from "../../extensions/supervisor-session/src/due-tasks.ts";
import supervisorSessionExtension from "../../extensions/supervisor-session/src/index.ts";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

interface RecordedRequest {
	method: string;
	path: string;
	authorization?: string;
	body: string;
}

/** A stand-in llm-tasks server: serves `due` from GET /tasks/due and answers acknowledgements with `ackStatus`. */
class TasksStub {
	due: Array<Record<string, unknown>> = [];
	ackStatus = 204;
	readonly requests: RecordedRequest[] = [];
	private readonly server: Server;

	constructor() {
		this.server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				const path = request.url ?? "";
				this.requests.push({
					method: request.method ?? "",
					path,
					authorization: request.headers.authorization,
					body,
				});
				if (request.method === "GET" && path === "/tasks/due") {
					response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(this.due));
					return;
				}
				// After an acknowledgement, accepted (204) or conflicting (409: rescheduled, closed or already
				// acknowledged), the task is no longer due as it was read.
				this.due = [];
				response.writeHead(this.ackStatus).end(this.ackStatus === 204 ? undefined : '{"error":"stale"}');
			});
		});
	}

	async listen(): Promise<string> {
		await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
		return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/`;
	}

	close(): Promise<void> {
		return new Promise((resolve) => this.server.close(() => resolve()));
	}

	acknowledgements(): RecordedRequest[] {
		return this.requests.filter((request) => request.method === "POST");
	}
}

const harnesses: Harness[] = [];
const stubs: TasksStub[] = [];

async function openSession(options: {
	supervisor: boolean;
	tasksUrl?: string;
	errors?: string[];
	retry?: boolean;
}): Promise<Harness> {
	const factory = (pi: ExtensionAPI) => supervisorSessionExtension(pi, { intervalMs: 20, readToken: () => "secret" });
	const harness = await createHarness({
		extensionFactories: [factory],
		settings: options.retry ? { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } } : undefined,
	});
	harnesses.push(harness);
	const sessionId = options.supervisor ? harness.sessionManager.getSessionId() : "another-session";
	harness.settingsManager.applyOverrides({ supervisor: { sessionId, tasksUrl: options.tasksUrl } });
	const uiContext = {
		...harness.session.extensionRunner.getUIContext(),
		notify: (message: string, type?: string) => {
			if (type === "error") options.errors?.push(message);
		},
	};
	await harness.session.bindExtensions({ mode: "rpc", uiContext });
	return harness;
}

async function startStub(): Promise<{ stub: TasksStub; url: string }> {
	const stub = new TasksStub();
	stubs.push(stub);
	return { stub, url: await stub.listen() };
}

function reminderTexts(harness: Harness): string[] {
	return harness.session.messages.flatMap((message) =>
		message.role === "custom" && message.customType === REMINDER_MESSAGE_TYPE && typeof message.content === "string"
			? [message.content]
			: [],
	);
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function endTurn(reason: string) {
	return fauxAssistantMessage([fauxToolCall("end_turn", { reason })], { stopReason: "toolUse" });
}

const DUE_TASK = {
	id: "lt-7ccc",
	title: "Review open-grove pool order",
	description: "Move open-grove after the paid members.",
	status: "pending",
	priority: 0,
	due_at: "2026-11-15T02:00:00Z",
	delivered_at: null,
};

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
	for (const stub of stubs.splice(0)) await stub.close();
});

describe("Supervisor due-task reminders", () => {
	it("delivers a due task once as a turn and acknowledges its due time after the entry is written", async () => {
		const { stub, url } = await startStub();
		stub.due = [DUE_TASK];
		const errors: string[] = [];
		const harness = await openSession({ supervisor: true, tasksUrl: url, errors });
		harness.setResponses([endTurn("Forwarded."), endTurn("Unexpected second turn.")]);

		await waitFor(() => stub.acknowledgements().length === 1, "the delivery acknowledgement");
		await new Promise((resolve) => setTimeout(resolve, 100));

		const reminders = reminderTexts(harness);
		expect(reminders).toHaveLength(1);
		expect(reminders[0]).toContain("Reminder due: lt-7ccc Review open-grove pool order (due 2026-11-15T02:00:00Z)");
		expect(reminders[0]).toContain("Move open-grove after the paid members.");
		expect(reminders[0]).toContain("context, not authorization");
		expect(stub.acknowledgements()).toHaveLength(1);
		const [ack] = stub.acknowledgements();
		expect(ack.path).toBe("/tasks/lt-7ccc/delivered");
		expect(JSON.parse(ack.body)).toEqual({ due_at: "2026-11-15T02:00:00Z" });
		expect(stub.requests.every((request) => request.authorization === "Bearer secret")).toBe(true);
		expect(errors).toEqual([]);
	});

	it("drops a reminder whose acknowledgement conflicts instead of retrying it", async () => {
		const { stub, url } = await startStub();
		stub.due = [DUE_TASK];
		stub.ackStatus = 409;
		const errors: string[] = [];
		const harness = await openSession({ supervisor: true, tasksUrl: url, errors });
		harness.setResponses([endTurn("Noted.")]);

		await waitFor(() => stub.acknowledgements().length === 1, "the conflicting acknowledgement");
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(stub.acknowledgements()).toHaveLength(1);
		expect(reminderTexts(harness)).toHaveLength(1);
		expect(errors).toEqual([]);
	});

	// A failed attempt ends a run before its automatic retry. Settling on that agent_end released the reminder
	// still queued for the retried run, so the next tick sent it again and the Supervisor got it twice.
	it("delivers a reminder queued during an attempt that is retried once", async () => {
		const { stub, url } = await startStub();
		const errors: string[] = [];
		const harness = await openSession({ supervisor: true, tasksUrl: url, errors, retry: true });
		const duePolls = () => stub.requests.filter((request) => request.path === "/tasks/due").length;
		harness.setResponses([
			async () => {
				stub.due = [DUE_TASK];
				const polls = duePolls();
				await waitFor(() => duePolls() >= polls + 2, "a tick that queues the reminder");
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
			},
			async () => {
				const polls = duePolls();
				await waitFor(() => duePolls() >= polls + 3, "ticks during the retried attempt");
				return fauxAssistantMessage("Work done.");
			},
			endTurn("Forwarded."),
			endTurn("Forwarded again."),
		]);

		await harness.session.prompt("Work.");
		await waitFor(() => stub.acknowledgements().length === 1, "the delivery acknowledgement");
		await new Promise((resolve) => setTimeout(resolve, 150));
		await harness.session.agent.waitForIdle();

		expect(reminderTexts(harness)).toHaveLength(1);
		expect(stub.acknowledgements()).toHaveLength(1);
		expect(errors).toEqual([]);
	});

	it("does not poll outside the Supervisor session or without tasksUrl", async () => {
		const { stub, url } = await startStub();
		stub.due = [DUE_TASK];
		const other = await openSession({ supervisor: false, tasksUrl: url });
		const unconfigured = await openSession({ supervisor: true });

		await new Promise((resolve) => setTimeout(resolve, 150));

		expect(stub.requests).toEqual([]);
		expect(reminderTexts(other)).toEqual([]);
		expect(reminderTexts(unconfigured)).toEqual([]);
	});
});
