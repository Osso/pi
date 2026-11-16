import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import supervisorSessionExtension, {
	SUPERVISOR_REQUEST_MESSAGE_TYPE,
	SUPERVISOR_RESUME_MESSAGE_TYPE,
	SUPERVISOR_SESSION_TOOL_NAMES,
} from "../../extensions/supervisor-session/src/index.ts";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import {
	getControlDbPath,
	postSupervisorRequest,
	readSupervisorRequest,
	type SupervisorRequestKind,
} from "../../src/core/session-control-db.ts";
import { getSupervisorRequestSocketPath, notifySupervisorRequest } from "../../src/supervisor/request-wake.ts";
import { SUPERVISOR_REQUEST_POLICY } from "../../src/supervisor/service.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const previousKbDir = process.env.PI_KB_DIR;

async function openSession(options: { supervisor: boolean }): Promise<Harness> {
	const harness = await createHarness({ extensionFactories: [supervisorSessionExtension] });
	harnesses.push(harness);
	process.env.PI_KB_DIR = join(harness.tempDir, "kb");
	mkdirSync(process.env.PI_KB_DIR, { recursive: true });
	if (options.supervisor) {
		harness.settingsManager.applyOverrides({ supervisor: { sessionId: harness.sessionManager.getSessionId() } });
	}
	await harness.session.bindExtensions({ mode: "rpc" });
	return harness;
}

function postRequest(harness: Harness, kind: SupervisorRequestKind, payload: Record<string, unknown>): number {
	const controlDbPath = getControlDbPath(harness.tempDir);
	const id = postSupervisorRequest(controlDbPath, {
		deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		kind,
		payload,
		projectId: "pi",
		senderSessionId: "asking-session",
	});
	notifySupervisorRequest(controlDbPath);
	return id;
}

function respond(args: Record<string, unknown>) {
	return fauxAssistantMessage([fauxToolCall("supervisor_response", args)], { stopReason: "toolUse" });
}

async function waitForCompletion(harness: Harness, id: number) {
	const controlDbPath = getControlDbPath(harness.tempDir);
	const deadline = Date.now() + 5_000;
	for (;;) {
		const request = readSupervisorRequest(controlDbPath, id);
		if (request?.status === "completed") return request;
		if (Date.now() > deadline) throw new Error(`Request ${id} not completed: ${request?.status}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function customTexts(harness: Harness, customType: string): string[] {
	return harness.session.messages.flatMap((message) =>
		message.role === "custom" && message.customType === customType && typeof message.content === "string"
			? [message.content]
			: [],
	);
}

function lastToolResultText(harness: Harness): string {
	const result = harness.session.messages.filter((message) => message.role === "toolResult").at(-1);
	if (!result || result.role !== "toolResult") throw new Error("No tool result");
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
	if (previousKbDir === undefined) delete process.env.PI_KB_DIR;
	else process.env.PI_KB_DIR = previousKbDir;
});

describe("interactive Supervisor session", () => {
	it("answers a queued approval as a visible turn and records the typed response", async () => {
		const harness = await openSession({ supervisor: true });
		let modelSaw = "";
		harness.setResponses([
			(context) => {
				const last = context.messages.at(-1);
				modelSaw = last?.role === "user" ? JSON.stringify(last.content) : "";
				return respond({ kind: "approve", reason: "bounded read" });
			},
		]);

		const id = postRequest(harness, "approval_review", { toolName: "read", input: { path: "README.md" } });
		const request = await waitForCompletion(harness, id);

		expect(request.response).toEqual({ kind: "approve", reason: "bounded read" });
		// The policy tells the model to call supervisor_response only for [Supervisor request] messages,
		// and the TUI label is not part of the model context, so the request text itself must carry it.
		expect(modelSaw).toContain("[Supervisor request] Call supervisor_response with kind approve or reject");
		const shown = customTexts(harness, SUPERVISOR_REQUEST_MESSAGE_TYPE);
		expect(shown).toHaveLength(1);
		expect(shown[0]).toContain('"toolName": "read"');
	});

	it("carries the request policy in the Supervisor session's system prompt only", async () => {
		const prompts: string[] = [];
		const capture = (context: { systemPrompt?: string }) => {
			prompts.push(context.systemPrompt ?? "");
			return fauxAssistantMessage("Done.");
		};
		const supervisor = await openSession({ supervisor: true });
		supervisor.setResponses([capture]);
		await supervisor.session.prompt("Hello.");
		const other = await openSession({ supervisor: false });
		other.setResponses([capture]);
		await other.session.prompt("Hello.");

		expect(prompts[0]).toContain(SUPERVISOR_REQUEST_POLICY);
		expect(prompts[1]).not.toContain("# Supervisor requests");
	});

	it("records an error response when the turn ends without supervisor_response", async () => {
		const harness = await openSession({ supervisor: true });
		harness.setResponses([fauxAssistantMessage("I think this is fine.")]);

		const id = postRequest(harness, "supervisor_advisory", { question: "Is this fine?" });
		const request = await waitForCompletion(harness, id);

		expect(request.response).toEqual({
			kind: "error",
			reason: "Supervisor turn ended without a supervisor_response call",
		});
	});

	it("interrupts a user chat turn for an approval, then resumes that turn", async () => {
		const harness = await openSession({ supervisor: true });
		harness.setResponses([
			(_context, options) =>
				new Promise((resolve) => {
					options?.signal?.addEventListener("abort", () =>
						resolve(fauxAssistantMessage("Stopped.", { stopReason: "aborted" })),
					);
				}),
			respond({ kind: "reject", reason: "outside scope" }),
			fauxAssistantMessage("Resumed the chat."),
		]);

		const chat = harness.session.prompt("Summarize the KB for me.");
		await new Promise((resolve) => setTimeout(resolve, 50));
		const id = postRequest(harness, "approval_review", { toolName: "bash", input: { command: "rm -rf /" } });
		await chat;
		const request = await waitForCompletion(harness, id);

		expect(request.response).toEqual({ kind: "reject", reason: "outside scope" });
		const deadline = Date.now() + 5_000;
		while (harness.getPendingResponseCount() > 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(customTexts(harness, SUPERVISOR_RESUME_MESSAGE_TYPE)).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("answers user chat in text: supervisor_response is blocked outside request turns", async () => {
		const harness = await openSession({ supervisor: true });
		harness.setResponses([
			respond({ kind: "advisory", answer: "Hidden in a tool call." }),
			fauxAssistantMessage("The blocker is cleared."),
		]);

		await harness.session.prompt("Why can't you clear that blocker?");

		expect(lastToolResultText(harness)).toContain("Answer the user's message in plain text");
		const answers = harness.session.messages.flatMap((message) =>
			message.role === "assistant"
				? message.content.filter((part) => part.type === "text").map((part) => part.text)
				: [],
		);
		expect(answers).toContain("The blocker is cleared.");

		harness.setResponses([respond({ kind: "approve", reason: "bounded read" })]);
		const id = postRequest(harness, "approval_review", { toolName: "read", input: { path: "README.md" } });
		expect((await waitForCompletion(harness, id)).response).toEqual({ kind: "approve", reason: "bounded read" });
	});

	it("limits tools to the allow-list but not file paths", async () => {
		const harness = await openSession({ supervisor: true });
		for (const name of harness.session.getActiveToolNames()) {
			expect(SUPERVISOR_SESSION_TOOL_NAMES).toContain(name);
		}

		const outside = join(harness.tempDir, "outside.md");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: outside, content: "kept" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("Write outside the KB.");
		expect(readFileSync(outside, "utf8")).toBe("kept");
	});

	it("leaves other sessions unrestricted and does not serve the queue", async () => {
		const harness = await openSession({ supervisor: false });
		expect(existsSync(getSupervisorRequestSocketPath(getControlDbPath(harness.tempDir)))).toBe(false);

		const outside = join(harness.tempDir, "outside.md");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: outside, content: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("Write a file.");
		expect(readFileSync(outside, "utf8")).toBe("x");
	});
});
