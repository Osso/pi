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

type HarnessOptions = NonNullable<Parameters<typeof createHarness>[0]>;

async function createRecoveryHarness(
	requester: HarnessOptions["supervisorDecisionRequester"],
	tools: AgentTool[] = [],
	extensionFactories?: HarnessOptions["extensionFactories"],
	overrides: Partial<HarnessOptions> = {},
) {
	const harness = await createHarness({
		extensionFactories,
		fauxProvider: { api: "openai-codex-responses", provider: "restriction-test" },
		settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		...overrides,
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

	it("tags only the validation agent_end and promises an attempt only when validation allows one", async () => {
		const extensionContinuations: Array<string | undefined> = [];
		const harness = await createRecoveryHarness(
			async () => ({ kind: "advisory", answer: JSON.stringify(ADVICE) }),
			[],
			[
				(pi) => {
					pi.on("agent_end", async (event) => {
						extensionContinuations.push(event.sessionContinuation);
					});
				},
			],
		);
		harness.setResponses([restriction(), approvedValidation(), fauxAssistantMessage("Source names listed")]);
		await harness.session.prompt(ORIGINAL);

		const ends = harness
			.eventsOfType("agent_end")
			.map(({ willRetry, sessionContinuation }) => ({ willRetry, sessionContinuation }));
		expect(ends).toEqual([
			{ willRetry: false, sessionContinuation: undefined },
			{ willRetry: true, sessionContinuation: "codex_restriction_validation" },
			{ willRetry: false, sessionContinuation: undefined },
		]);
		expect(extensionContinuations).toEqual([undefined, "codex_restriction_validation", undefined]);

		const denied = await createRecoveryHarness(async () => ({ kind: "advisory", answer: JSON.stringify(ADVICE) }));
		denied.setResponses([
			restriction(),
			fauxAssistantMessage(
				JSON.stringify({ allowed: false, task: SUBTASK, reason: "Not clearly authorized.", basisQuote: "" }),
			),
		]);
		await denied.session.prompt(ORIGINAL);
		expect(
			denied
				.eventsOfType("agent_end")
				.map(({ willRetry, sessionContinuation }) => ({ willRetry, sessionContinuation })),
		).toEqual([
			{ willRetry: false, sessionContinuation: undefined },
			{ willRetry: false, sessionContinuation: "codex_restriction_validation" },
		]);
		expect(denied.faux.state.callCount).toBe(2);
	});

	it("does not retry a transient error on the one recovery attempt", async () => {
		const harness = await createRecoveryHarness(async () => ({ kind: "advisory", answer: JSON.stringify(ADVICE) }));
		harness.setResponses([
			restriction(),
			approvedValidation(),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("Resent attempt"),
		]);
		await harness.session.prompt(ORIGINAL);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expect(harness.eventsOfType("agent_end").at(-1)?.willRetry).toBe(false);
	});

	it("does not switch to a quota fallback provider on the one recovery attempt", async () => {
		const harness = await createRecoveryHarness(
			async () => ({ kind: "advisory", answer: JSON.stringify(ADVICE) }),
			[],
			undefined,
			{ fauxProvider: { api: "openai-codex-responses", provider: "openai-codex" } },
		);
		const model = harness.getModel();
		harness.session.modelRegistry.registerProvider("openai-codex-gc", {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: model.api,
			models: [{ ...model, input: model.input }],
		});
		harness.authStorage.setRuntimeApiKey("openai-codex-gc", "faux-key");
		expect(harness.session.modelRegistry.find("openai-codex-gc", model.id)).toBeDefined();
		const providers: string[] = [];
		const record =
			(response: ReturnType<typeof fauxAssistantMessage>) =>
			(_context: Context, _options: SimpleStreamOptions | undefined, _state: unknown, active: Model<string>) => {
				providers.push(active.provider);
				return response;
			};
		harness.setResponses([
			record(restriction()),
			record(approvedValidation()),
			record(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "You have hit your ChatGPT usage limit" }),
			),
			record(fauxAssistantMessage("Fallback attempt")),
		]);
		await harness.session.prompt(ORIGINAL);
		expect(providers).toEqual(["openai-codex", "openai-codex", "openai-codex"]);
		expect(harness.session.model?.provider).toBe("openai-codex");
		expect(harness.eventsOfType("agent_end").at(-1)?.willRetry).toBe(false);
	});

	it("restores tools on validation timeout settlement without resending validation", async () => {
		const reads: string[] = [];
		const harness = await createRecoveryHarness(
			async () => ({ kind: "advisory", answer: JSON.stringify(ADVICE) }),
			[createReadProbe(reads)],
			undefined,
			{ thinkingPhaseTimeoutMs: 200 },
		);
		harness.setResponses([
			restriction(),
			async (context, options) => {
				expectValidationContext(context);
				expect(harness.session.getActiveToolNames()).toEqual([]);
				const signal = options?.signal;
				if (!signal) throw new Error("Expected provider cancellation signal");
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
				return fauxAssistantMessage("Never delivered");
			},
			approvedValidation(),
			fauxAssistantMessage("Resent attempt"),
		]);
		await expect(harness.session.prompt(ORIGINAL)).rejects.toThrow("Main session thinking phase exceeded 20 minutes");
		expect(harness.session.getActiveToolNames()).toEqual(["read"]);
		expect(reads).toEqual([]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(2);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
	});

	it.each(["timeout", "abort"] as const)(
		"retries a new human request normally after operative %s settlement",
		async (interruption) => {
			let requests = 0;
			let entered: (() => void) | undefined;
			const operativeStarted = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const harness = await createRecoveryHarness(
				async () => {
					requests++;
					return { kind: "advisory", answer: JSON.stringify(ADVICE) };
				},
				[],
				undefined,
				{ thinkingPhaseTimeoutMs: interruption === "timeout" ? 200 : 0 },
			);
			harness.setResponses([
				restriction(),
				approvedValidation(),
				async (_context, options) => {
					const signal = options?.signal;
					if (!signal) throw new Error("Expected provider cancellation signal");
					const aborted = new Promise<void>((resolve) => {
						signal.addEventListener("abort", () => resolve(), { once: true });
					});
					entered?.();
					await aborted;
					return fauxAssistantMessage("Never delivered");
				},
			]);
			const run = harness.session.prompt(ORIGINAL);
			await operativeStarted;
			if (interruption === "timeout") {
				await expect(run).rejects.toThrow("Main session thinking phase exceeded 20 minutes");
			} else {
				await harness.session.abort();
				await run;
			}
			expect(harness.faux.state.callCount).toBe(3);
			expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
			expect(harness.session.messages.at(-1)).toEqual(expect.objectContaining({ stopReason: "aborted" }));

			const followUp = "Explain what a TypeScript filename extension means.";
			harness.setResponses([
				(context) => {
					expect(textOf(context)).toContain(followUp);
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
				},
				fauxAssistantMessage("TypeScript source filenames use the .ts extension."),
			]);
			await harness.session.prompt(followUp);
			expect(harness.faux.state.callCount).toBe(5);
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(requests).toBe(1);
			expect(harness.eventsOfType("auto_retry_start")).toEqual([
				expect.objectContaining({ errorMessage: "overloaded_error", attempt: 1 }),
			]);
			expect(
				harness
					.eventsOfType("agent_end")
					.slice(-2)
					.map(({ willRetry }) => willRetry),
			).toEqual([true, false]);
			expect(harness.session.messages.at(-1)).toEqual(
				expect.objectContaining({
					role: "assistant",
					content: [{ type: "text", text: "TypeScript source filenames use the .ts extension." }],
				}),
			);
		},
	);

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
