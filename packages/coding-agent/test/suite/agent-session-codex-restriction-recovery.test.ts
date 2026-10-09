import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const ORIGINAL = "In my own repository, list source filenames and explain the code; do not read credentials.";
const RESTRICTION = "Codex error: This content was flagged for possible cybersecurity risk. OpenAI request ID: req_500";
const SUBTASK = "List source filenames only, without opening credentials or running commands.";
const ADVICE = {
	kind: "rescope",
	task: SUBTASK,
	basisQuote: "list source filenames",
	reason: "A metadata-only subset of the authorized repository inspection.",
};

function restriction() {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage: RESTRICTION });
}

function textOf(context: Context): string {
	return JSON.stringify(context.messages);
}

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function createRecoveryHarness(
	requester: NonNullable<Parameters<typeof createHarness>[0]>["supervisorDecisionRequester"],
) {
	const harness = await createHarness({
		fauxProvider: { api: "openai-codex-responses", provider: "restriction-test" },
		settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		supervisorDecisionRequester: requester,
	});
	harness.session.setActiveToolsByName([]);
	harnesses.push(harness);
	return harness;
}

describe("Codex restriction rescope", () => {
	it("consults once and attempts a narrower task on the unchanged model without dropping the request or refusal", async () => {
		const requests: unknown[] = [];
		const harness = await createRecoveryHarness(async (request) => {
			requests.push(request);
			expect(request.kind).toBe("supervisor_advisory");
			const evidence = JSON.parse(String(request.payload.context));
			expect(evidence.originalUserRequest).toBe(ORIGINAL);
			expect(evidence.failure.errorMessage).toBe(RESTRICTION);
			return { kind: "advisory", answer: JSON.stringify(ADVICE) };
		});
		const initialModel = harness.session.model;
		const goal = JSON.stringify({ objective: "Inspect the authorized repository", status: "active" });
		harness.sessionManager.setSessionGoalJson(goal);
		harness.setResponses([
			restriction(),
			(
				context: Context,
				_options: SimpleStreamOptions | undefined,
				_state: { callCount: number },
				model: Model<string>,
			) => {
				expect(model.id).toBe(initialModel?.id);
				expect(model.provider).toBe(initialModel?.provider);
				expect(textOf(context)).toContain(ORIGINAL);
				expect(textOf(context)).toContain(RESTRICTION);
				expect(textOf(context)).toContain(SUBTASK);
				return fauxAssistantMessage("The permitted source filenames are listed.");
			},
		]);
		await harness.session.prompt(ORIGINAL);
		expect(requests).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.model).toBe(initialModel);
		expect(harness.sessionManager.getSessionGoalJson()).toBe(goal);
		expect(
			harness.session.messages.some(
				(message) => message.role === "assistant" && message.errorMessage === RESTRICTION,
			),
		).toBe(true);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
	});

	it("stops after a second flag instead of repeatedly rescoping", async () => {
		let requests = 0;
		const harness = await createRecoveryHarness(async () => {
			requests++;
			return { kind: "advisory", answer: JSON.stringify(ADVICE) };
		});
		harness.setResponses([restriction(), restriction()]);
		await harness.session.prompt(ORIGINAL);
		expect(requests).toBe(1);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
	});

	it("does not consult again for an extension-generated continuation, but permits a new explicit user request", async () => {
		let requests = 0;
		const harness = await createRecoveryHarness(async () => {
			requests++;
			return { kind: "advisory", answer: JSON.stringify(ADVICE) };
		});
		harness.setResponses([restriction(), restriction(), restriction(), restriction(), fauxAssistantMessage("Done")]);
		await harness.session.prompt(ORIGINAL);
		await harness.session.prompt("Continue the active goal.", { source: "extension" });
		expect(requests).toBe(1);
		await harness.session.prompt(ORIGINAL, { source: "rpc" });
		expect(requests).toBe(2);
		expect(harness.faux.state.callCount).toBe(5);
	});

	it("does not collect recovery evidence or consult in standalone mode", async () => {
		let requests = 0;
		const harness = await createHarness({
			noSupervisor: true,
			fauxProvider: { api: "openai-codex-responses", provider: "standalone-restriction-test" },
			supervisorDecisionRequester: async () => {
				requests++;
				return { kind: "advisory", answer: JSON.stringify(ADVICE) };
			},
		});
		harnesses.push(harness);
		harness.setResponses([restriction()]);
		await harness.session.prompt(ORIGINAL);
		expect(requests).toBe(0);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "custom")).toEqual([]);
	});

	it("leaves the refusal terminal when no permitted scope exists", async () => {
		const harness = await createRecoveryHarness(async () => ({
			kind: "advisory",
			answer: JSON.stringify({
				kind: "blocked",
				reason: "Existing authorization does not support a permitted narrower task.",
			}),
		}));
		harness.setResponses([restriction()]);
		await harness.session.prompt(ORIGINAL);
		expect(harness.faux.state.callCount).toBe(1);
		expect(
			harness.session.messages.some(
				(message) =>
					message.role === "custom" && JSON.stringify(message.content).includes("Existing authorization"),
			),
		).toBe(true);
	});

	it("does not replace newer model selection with a stale recovery", async () => {
		let release: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered: (() => void) | undefined;
		const requested = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const harness = await createRecoveryHarness(async () => {
			entered?.();
			await pending;
			return { kind: "advisory", answer: JSON.stringify(ADVICE) };
		});
		harness.setResponses([restriction()]);
		const run = harness.session.prompt(ORIGINAL);
		await requested;
		harness.sessionManager.appendCustomEntry("external-context-change", { value: "new user context" });
		release?.();
		await run;
		expect(harness.faux.state.callCount).toBe(1);
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && JSON.stringify(message.content).includes(SUBTASK),
			),
		).toBe(false);
	});

	it("cancels stale assistance when new external input is reserved", async () => {
		let release: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered: (() => void) | undefined;
		const requested = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let signal: AbortSignal | undefined;
		const harness = await createRecoveryHarness(async (request) => {
			signal = request.signal;
			entered?.();
			await pending;
			return { kind: "advisory", answer: JSON.stringify(ADVICE) };
		});
		harness.setResponses([restriction(), fauxAssistantMessage("unexpected old work")]);
		const run = harness.session.prompt(ORIGINAL);
		await requested;
		const releaseInput = harness.session.reserveExternalUserInput();
		const wasAborted = signal?.aborted;
		release?.();
		await run;
		releaseInput();
		expect(wasAborted).toBe(true);
		expect(harness.faux.state.callCount).toBe(1);
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && JSON.stringify(message.content).includes(SUBTASK),
			),
		).toBe(false);
	});

	it("cancels pending assistance and discards a late rescope", async () => {
		let release: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered: (() => void) | undefined;
		const requested = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let signal: AbortSignal | undefined;
		const harness = await createRecoveryHarness(async (request) => {
			signal = request.signal;
			entered?.();
			await pending;
			return { kind: "advisory", answer: JSON.stringify(ADVICE) };
		});
		harness.setResponses([restriction()]);
		const run = harness.session.prompt(ORIGINAL);
		await requested;
		await harness.session.abort();
		expect(signal?.aborted).toBe(true);
		release?.();
		await run;
		expect(harness.faux.state.callCount).toBe(1);
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && JSON.stringify(message.content).includes(SUBTASK),
			),
		).toBe(false);
	});
});
