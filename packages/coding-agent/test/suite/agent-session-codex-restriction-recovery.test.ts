import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
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

function approvedValidation() {
	return fauxAssistantMessage(
		JSON.stringify({
			allowed: true,
			task: SUBTASK,
			reason: "Listing source names respects the original request and its credential prohibition.",
			basisQuote: ADVICE.basisQuote,
		}),
	);
}

function expectValidationContext(context: Context | undefined, proposal = ADVICE) {
	expect(context).toBeDefined();
	if (!context) throw new Error("Validation request was not observed");
	expect(context.tools).toEqual([]);
	const request = textOf(context);
	expect(request).toContain(ORIGINAL);
	expect(request).toContain(RESTRICTION);
	expect(request).toContain(proposal.task);
	expect(request).toContain(proposal.basisQuote);
	expect(request).toContain("nonbinding");
	expect(request).toContain("not permission");
}

const readProbeParameters = Type.Object({ path: Type.String() });

function createReadProbe(reads: string[]): AgentTool<typeof readProbeParameters> {
	return {
		name: "read",
		label: "Read fixture",
		description: "Record a synthetic read without accessing the filesystem.",
		parameters: readProbeParameters,
		execute: async (_toolCallId, params) => {
			reads.push(params.path);
			return { content: [{ type: "text", text: "fixture source" }], details: undefined };
		},
	};
}

function readRequestContext(harness: Harness) {
	const entries = harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom" && entry.customType === "codex_restriction_context");
	const entry = entries[entries.length - 1];
	if (!entry || entry.type !== "custom") throw new Error("Missing persisted restriction request context");
	const context = entry.data as { requestId: string; userRequest: string };
	expect(context.userRequest).toBe(ORIGINAL);
	expect(context.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
	return context;
}

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function createRecoveryHarness(
	requester: NonNullable<Parameters<typeof createHarness>[0]>["supervisorDecisionRequester"],
	tools: AgentTool[] = [],
) {
	const harness = await createHarness({
		fauxProvider: { api: "openai-codex-responses", provider: "restriction-test" },
		settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		supervisorDecisionRequester: requester,
		tools,
		initialActiveToolNames: tools.map((tool) => tool.name),
		models: [
			{ id: "restriction-main", name: "Main", reasoning: true },
			{ id: "restriction-new", name: "New selection", reasoning: true },
		],
	});
	harnesses.push(harness);
	harness.session.setActiveToolsByName(tools.map((tool) => tool.name));
	expect(harness.session.getActiveToolNames()).toEqual(tools.map((tool) => tool.name));
	return harness;
}

describe("Codex restriction rescope", () => {
	it("consults once and attempts a narrower task on the unchanged model without dropping the request or refusal", async () => {
		const requests: unknown[] = [];
		const reads: string[] = [];
		let validationContext: Context | undefined;
		const harness = await createRecoveryHarness(
			async (request) => {
				requests.push(request);
				expect(request.kind).toBe("supervisor_advisory");
				const evidence = JSON.parse(String(request.payload.context));
				expect(evidence.originalUserRequest).toBe(ORIGINAL);
				expect(evidence.failure.errorMessage).toBe(RESTRICTION);
				return { kind: "advisory", answer: JSON.stringify(ADVICE) };
			},
			[createReadProbe(reads)],
		);
		const initialModel = harness.session.model;
		const goal = JSON.stringify({ objective: "Inspect the authorized repository", status: "active" });
		harness.sessionManager.setSessionGoalJson(goal);
		harness.setResponses([
			restriction(),
			(context, _options, _state, model) => {
				validationContext = context;
				expect(model.id).toBe(initialModel?.id);
				expect(model.provider).toBe(initialModel?.provider);
				return approvedValidation();
			},
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
				expect(context.tools?.map((tool) => tool.name)).toEqual(["read"]);
				return fauxAssistantMessage("The permitted source filenames are listed.");
			},
		]);
		await harness.session.prompt(ORIGINAL);
		expect(requests).toHaveLength(1);
		expectValidationContext(validationContext);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.getActiveToolNames()).toEqual(["read"]);
		expect(reads).toEqual([]);
		expect(harness.session.messages).toContainEqual(
			expect.objectContaining({
				role: "assistant",
				content: [{ type: "text", text: "The permitted source filenames are listed." }],
			}),
		);
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
		harness.setResponses([restriction(), approvedValidation(), restriction()]);
		await harness.session.prompt(ORIGINAL);
		expect(requests).toBe(1);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
	});

	it("does not consult again for an extension-generated continuation, but permits a new explicit user request", async () => {
		let requests = 0;
		const harness = await createRecoveryHarness(async () => {
			requests++;
			return { kind: "advisory", answer: JSON.stringify(ADVICE) };
		});
		harness.setResponses([
			restriction(),
			approvedValidation(),
			restriction(),
			restriction(),
			restriction(),
			approvedValidation(),
			fauxAssistantMessage("Done"),
		]);
		await harness.session.prompt(ORIGINAL);
		const firstRequest = readRequestContext(harness);
		await harness.session.prompt("Continue the active goal.", { source: "extension" });
		expect(readRequestContext(harness)).toEqual(firstRequest);
		expect(requests).toBe(1);
		await harness.session.prompt(ORIGINAL, { source: "rpc" });
		expect(readRequestContext(harness).requestId).not.toBe(firstRequest.requestId);
		expect(requests).toBe(2);
		expect(harness.faux.state.callCount).toBe(7);
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

	it.each(["model", "goal", "request"] as const)("discards advice after a real %s change", async (change) => {
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
		if (change === "model") {
			await harness.session.setModel(harness.models[1]);
		} else if (change === "goal") {
			harness.sessionManager.setSessionGoalJson(
				JSON.stringify({ objective: "Explain public documentation", status: "active" }),
			);
		} else {
			harness.sessionManager.appendCustomEntry("codex_restriction_context", {
				requestId: "e960c6eb-e084-43c0-a2a5-d4b02b5a259d",
				userRequest: "Explain public documentation only.",
			});
		}
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

	it("ignores harmless status metadata while awaiting advice", async () => {
		const harness = await createRecoveryHarness(async () => {
			harness.sessionManager.appendCustomEntry("status", { message: "Still inspecting repository" });
			return { kind: "advisory", answer: JSON.stringify(ADVICE) };
		});
		harness.setResponses([restriction(), approvedValidation(), fauxAssistantMessage("Source names listed")]);
		await harness.session.prompt(ORIGINAL);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.messages).toContainEqual(
			expect.objectContaining({
				role: "assistant",
				content: [{ type: "text", text: "Source names listed" }],
			}),
		);
	});

	it("lets main deny a Supervisor proposal quoting a credential prohibition and restores tools", async () => {
		const proposal = {
			kind: "rescope",
			task: "Read credentials from the repository.",
			basisQuote: "do not read credentials",
			reason: "The request mentions credentials.",
		};
		const reads: string[] = [];
		let validationContext: Context | undefined;
		let requests = 0;
		const harness = await createRecoveryHarness(async () => {
			requests++;
			return { kind: "advisory", answer: JSON.stringify(proposal) };
		}, [createReadProbe(reads)]);
		harness.setResponses([
			restriction(),
			(context) => {
				validationContext = context;
				return fauxAssistantMessage(
					JSON.stringify({
						allowed: false,
						task: proposal.task,
						reason: "The quoted text prohibits credential reads; it does not authorize them.",
						basisQuote: proposal.basisQuote,
					}),
				);
			},
			fauxAssistantMessage(fauxToolCall("read", { path: "credentials" }), { stopReason: "toolUse" }),
		]);
		await harness.session.prompt(ORIGINAL);
		expectValidationContext(validationContext, proposal);
		expect(requests).toBe(1);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(reads).toEqual([]);
		expect(harness.eventsOfType("tool_execution_start")).toHaveLength(0);
		expect(harness.session.getActiveToolNames()).toEqual(["read"]);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "src/example.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Read authorized fixture"),
		]);
		await harness.session.prompt("Read src/example.ts only.");
		expect(reads).toEqual(["src/example.ts"]);
		expect(harness.faux.state.callCount).toBe(4);
		expect(requests).toBe(1);
	});

	it("never executes an attempted tool during validation and stops without an operative call", async () => {
		const reads: string[] = [];
		let validationContext: Context | undefined;
		const harness = await createRecoveryHarness(
			async () => ({
				kind: "advisory",
				answer: JSON.stringify(ADVICE),
			}),
			[createReadProbe(reads)],
		);
		harness.setResponses([
			restriction(),
			(context) => {
				validationContext = context;
				return fauxAssistantMessage(fauxToolCall("read", { path: "credentials" }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("Unexpected operation after tool-use validation"),
		]);
		await harness.session.prompt(ORIGINAL);
		expectValidationContext(validationContext);
		expect(reads).toEqual([]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.getActiveToolNames()).toEqual(["read"]);
	});

	it.each([
		["provider error", fauxAssistantMessage("", { stopReason: "error", errorMessage: "Validation failed" })],
		["malformed JSON", fauxAssistantMessage("not JSON")],
		["missing field", fauxAssistantMessage(JSON.stringify({ allowed: true, task: SUBTASK, reason: "Permitted" }))],
	] as const)("stops after validation %s and restores tools", async (_label, response) => {
		const reads: string[] = [];
		let validationContext: Context | undefined;
		const harness = await createRecoveryHarness(
			async () => ({
				kind: "advisory",
				answer: JSON.stringify(ADVICE),
			}),
			[createReadProbe(reads)],
		);
		harness.setResponses([
			restriction(),
			(context) => {
				validationContext = context;
				return response;
			},
			fauxAssistantMessage("Unexpected operation after invalid validation"),
		]);
		await harness.session.prompt(ORIGINAL);
		expectValidationContext(validationContext);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(reads).toEqual([]);
		expect(harness.session.getActiveToolNames()).toEqual(["read"]);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
	});

	it("restores the original tools after aborting validation and discards late approval", async () => {
		const reads: string[] = [];
		let validationContext: Context | undefined;
		let release: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered: (() => void) | undefined;
		const validating = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const harness = await createRecoveryHarness(
			async () => ({
				kind: "advisory",
				answer: JSON.stringify(ADVICE),
			}),
			[createReadProbe(reads)],
		);
		harness.setResponses([
			restriction(),
			async (context) => {
				validationContext = context;
				entered?.();
				await pending;
				return approvedValidation();
			},
			fauxAssistantMessage("Unexpected operation after abort"),
		]);
		const run = harness.session.prompt(ORIGINAL);
		await validating;
		expectValidationContext(validationContext);
		expect(harness.session.getActiveToolNames()).toEqual([]);
		const abort = harness.session.abort();
		release?.();
		await abort;
		await run;
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(reads).toEqual([]);
		expect(harness.session.getActiveToolNames()).toEqual(["read"]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "src/after-abort.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Read fixture after abort"),
		]);
		await harness.session.prompt("Read src/after-abort.ts only.");
		expect(reads).toEqual(["src/after-abort.ts"]);
		expect(harness.faux.state.callCount).toBe(4);
	});
});
