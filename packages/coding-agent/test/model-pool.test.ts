import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	getSupportedThinkingLevels,
	type Model,
	registerApiProvider,
	resetApiProviders,
	type SimpleStreamOptions,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { POOL_EXHAUSTION_COOLDOWN_MS } from "../src/core/model-pool.ts";
import { ModelRegistry, type ProviderConfigInput } from "../src/core/model-registry.ts";

const FIRST = "pool-test-first";
const SECOND = "pool-test-second";
const FIRST_ID = "deepseek/deepseek-v4.1-flash";
const SECOND_ID = "deepseek-flash";
const context: Context = { messages: [{ role: "user", content: "Say hello", timestamp: 1 }] };

function provider(id: string, overrides: Partial<NonNullable<ProviderConfigInput["models"]>[number]> = {}) {
	return {
		baseUrl: "https://pool-test.invalid/v1",
		api: "pool-test",
		apiKey: `fixture-key-${id}`,
		models: [
			{
				id,
				name: id,
				reasoning: true,
				input: ["text", "image"] as ("text" | "image")[],
				contextWindow: 128000,
				maxTokens: 16000,
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
				...overrides,
			},
		],
	};
}

function message(model: Model<Api>, errorMessage?: string, retryAfterMs?: number): AssistantMessage {
	return {
		role: "assistant",
		provider: model.provider,
		model: model.id,
		api: model.api,
		content: errorMessage ? [] : [{ type: "text", text: "Hello" }],
		stopReason: errorMessage ? "error" : "stop",
		errorMessage,
		retryAfterMs,
		usage: {
			input: 4,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 5,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 123,
	};
}

function events(
	model: Model<Api>,
	errorMessage?: string,
	outputType?: "text_start" | "thinking_start" | "toolcall_start",
	retryAfterMs?: number,
) {
	const result = message(model, errorMessage, retryAfterMs);
	const resultEvents: AssistantMessageEvent[] = [{ type: "start", partial: result }];
	if (outputType) resultEvents.push({ type: outputType, contentIndex: 0, partial: result });
	if (errorMessage) resultEvents.push({ type: "error", reason: "error", error: result });
	else resultEvents.push({ type: "done", reason: "stop", message: result });
	return resultEvents;
}

function fromEvents(items: AssistantMessageEvent[]): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	for (const event of items) stream.push(event);
	stream.end();
	return stream;
}

async function collect(stream: AssistantMessageEventStream) {
	const items: AssistantMessageEvent[] = [];
	for await (const event of stream) items.push(event);
	return { events: items, result: await stream.result() };
}

describe("model pools", () => {
	let tempDir: string;
	let modelsPath: string;
	let auth: AuthStorage;
	let now: number;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-model-pool-"));
		modelsPath = join(tempDir, "models.json");
		auth = AuthStorage.inMemory();
		now = 1000;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		resetApiProviders();
		rmSync(tempDir, { recursive: true, force: true });
	});

	function registry(
		providers: Record<string, ProviderConfigInput> = { [FIRST]: provider(FIRST_ID), [SECOND]: provider(SECOND_ID) },
		pools: Record<string, string[]> = { flash: [`${FIRST}/${FIRST_ID}`, `${SECOND}/${SECOND_ID}`] },
	) {
		writeFileSync(modelsPath, JSON.stringify({ providers, pools }));
		return ModelRegistry.create(auth, modelsPath, () => now);
	}

	function pool(reg: ModelRegistry) {
		const model = reg.find("pool", "flash");
		expect(model).toBeDefined();
		return model!;
	}

	function register(
		handler: (model: Model<Api>, ctx: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream,
	) {
		const fn = vi.fn(handler);
		registerApiProvider({ api: "pool-test", stream: fn, streamSimple: fn });
		return fn;
	}

	test("parses member ids at the first slash and skips unresolvable individual members", async () => {
		const reg = registry(undefined, {
			flash: ["missing/nope", "malformed", `pool-test-first/${FIRST_ID}`, "pool-test-second/unknown"],
		});
		expect(reg.getError()).toBeUndefined();
		expect(pool(reg)).toMatchObject({ provider: "pool", id: "flash", name: "Pool flash", api: "pool" });
		const request = register((model) => fromEvents(events(model)));
		const result = await streamSimple(pool(reg), context).result();
		expect(result).toMatchObject({ provider: FIRST, model: FIRST_ID, api: "pool-test" });
		expect(request).toHaveBeenCalledTimes(1);
	});

	test("reports empty and fully unresolved pools while retaining valid pools and real models", () => {
		const reg = registry(undefined, {
			empty: [],
			missing: ["no-such-provider/no-model", "missing-slash"],
			flash: [`${FIRST}/${FIRST_ID}`],
		});
		expect(reg.find("pool", "empty")).toBeUndefined();
		expect(reg.find("pool", "missing")).toBeUndefined();
		expect(reg.getError()).toContain('Pool "empty": no members resolve');
		expect(reg.getError()).toContain('Pool "missing": no members resolve');
		expect(reg.find(FIRST, FIRST_ID)).toBeDefined();
		expect(pool(reg)).toBeDefined();
	});

	test("derives restrictive metadata and identity thinking maps from all resolved members", () => {
		const first = provider(FIRST_ID, { thinkingLevelMap: { high: "first-high", xhigh: "first-max", max: "max" } });
		const second = provider(SECOND_ID, {
			contextWindow: 64000,
			maxTokens: 4000,
			input: ["text"],
			thinkingLevelMap: { off: null, low: null, high: "second-high", xhigh: "second-max" },
			cost: { input: 9, output: 10, cacheRead: 2, cacheWrite: 3 },
		});
		const selected = pool(registry({ [FIRST]: first, [SECOND]: second }));
		expect(selected).toMatchObject({
			contextWindow: 64000,
			maxTokens: 4000,
			input: ["text"],
			reasoning: true,
			cost: first.models[0].cost,
			thinkingLevelMap: {
				off: null,
				minimal: "minimal",
				low: null,
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: null,
				ultra: null,
			},
		});
		expect(getSupportedThinkingLevels(selected)).toEqual(["minimal", "medium", "high", "xhigh"]);
	});

	test("does not advertise reasoning if any member cannot reason", () => {
		const reg = registry({ [FIRST]: provider(FIRST_ID), [SECOND]: provider(SECOND_ID, { reasoning: false }) });
		expect(pool(reg).reasoning).toBe(false);
		expect(pool(reg).thinkingLevelMap).toEqual({
			off: "off",
			minimal: null,
			low: null,
			medium: null,
			high: null,
			xhigh: null,
			max: null,
			ultra: null,
		});
		expect(getSupportedThinkingLevels(pool(reg))).toEqual(["off"]);
	});

	test("auth availability requires any member's auth, not pool credentials", () => {
		const first = { ...provider(FIRST_ID), apiKey: undefined };
		const second = { ...provider(SECOND_ID), apiKey: undefined };
		const reg = registry({ [FIRST]: first, [SECOND]: second });
		auth.setRuntimeApiKey("pool", "irrelevant-pool-key");
		expect(reg.hasConfiguredAuth(pool(reg))).toBe(false);
		auth.setRuntimeApiKey(SECOND, "second-fixture-key");
		expect(reg.hasConfiguredAuth(pool(reg))).toBe(true);
		expect(reg.getAvailable()).toContain(pool(reg));
	});

	test("uses each member's own key with caller headers and env layered over member auth", async () => {
		const reg = registry({
			[FIRST]: { ...provider(FIRST_ID), headers: { "X-Member": "$MEMBER_HEADER" } },
			[SECOND]: { ...provider(SECOND_ID), headers: { "X-Member": "$MEMBER_HEADER" } },
		});
		auth.set(FIRST, { type: "api_key", key: "first-key", env: { MEMBER_HEADER: "first-header" } });
		auth.set(SECOND, { type: "api_key", key: "second-key", env: { MEMBER_HEADER: "second-header" } });
		const seen: Array<{ model: Model<Api>; ctx: Context; options?: SimpleStreamOptions }> = [];
		register((model, ctx, options) => {
			seen.push({ model, ctx, options });
			return fromEvents(events(model, model.provider === FIRST ? "insufficient_quota" : undefined));
		});
		const signal = new AbortController().signal;
		await streamSimple(pool(reg), context, {
			apiKey: "pool-key-must-not-leak",
			headers: { "X-Caller": "caller-header" },
			env: { CALLER_ENV: "caller-env" },
			temperature: 0.4,
			reasoning: "high",
			signal,
		}).result();
		expect(seen.map(({ model }) => model)).toEqual([reg.find(FIRST, FIRST_ID), reg.find(SECOND, SECOND_ID)]);
		for (const [index, label] of ["first", "second"].entries()) {
			expect(seen[index].ctx).toBe(context);
			expect(seen[index].options).toEqual({
				apiKey: `${label}-key`,
				headers: { "X-Member": `${label}-header`, "X-Caller": "caller-header" },
				env: { MEMBER_HEADER: `${label}-header`, CALLER_ENV: "caller-env" },
				temperature: 0.4,
				reasoning: "high",
				signal,
			});
		}
	});

	test.each([
		"insufficient_quota",
		'{"error":{"message":"Insufficient Balance","type":"unknown_error"}}',
		'402 This request requires more credits, or fewer max_tokens. You requested up to 131072 tokens, but can only afford 18096. {"code":402,"metadata":{"error_type":"payment_required"}}',
	])("rotates before output for %s and exposes only the successful member events", async (error) => {
		const reg = registry();
		const successful = events(reg.find(SECOND, SECOND_ID)!);
		const request = register((model) => fromEvents(model.provider === FIRST ? events(model, error) : successful));
		const actual = await collect(streamSimple(pool(reg), context));
		expect(request.mock.calls.map(([model]) => model.provider)).toEqual([FIRST, SECOND]);
		expect(actual.events).toEqual(successful);
		for (const [index, event] of actual.events.entries()) expect(event).toBe(successful[index]);
		expect(actual.result).toBe(messageFromEvent(successful[1]));
	});

	test("rotates before output when a rate limit requests a longer delay than the cap", async () => {
		const reg = registry();
		const successful = events(reg.find(SECOND, SECOND_ID)!);
		const request = register((model) =>
			fromEvents(
				model.provider === FIRST ? events(model, "429 rate limit reached", undefined, 520_526_000) : successful,
			),
		);
		const actual = await collect(streamSimple(pool(reg), context, { maxRetryDelayMs: 60_000 }));
		expect(request.mock.calls.map(([model]) => model.provider)).toEqual([FIRST, SECOND]);
		expect(actual.result).toBe(messageFromEvent(successful[1]));
	});

	test("does not rotate when the requested retry delay fits within the cap", async () => {
		const reg = registry();
		const original = events(reg.find(FIRST, FIRST_ID)!, "429 rate limit reached", undefined, 5_000);
		const request = register(() => fromEvents(original));
		const actual = await collect(streamSimple(pool(reg), context, { maxRetryDelayMs: 60_000 }));
		expect(request.mock.calls.map(([model]) => model.provider)).toEqual([FIRST]);
		expect(actual.result).toBe(messageFromEvent(original[1]));
	});

	test("does not rotate on non-quota errors and forwards start and error unchanged", async () => {
		const reg = registry();
		const original = events(reg.find(FIRST, FIRST_ID)!, "429 too many requests; retry later");
		const request = register(() => fromEvents(original));
		const actual = await collect(streamSimple(pool(reg), context));
		expect(actual.events).toEqual(original);
		expect(actual.result).toBe(messageFromEvent(original[1]));
		await streamSimple(pool(reg), context).result();
		expect(request.mock.calls.map(([model]) => model.provider)).toEqual([FIRST, FIRST]);
	});

	test.each(["text_start", "thinking_start", "toolcall_start"] as const)(
		"does not rotate after %s, even when the terminal error says insufficient_quota",
		async (outputType) => {
			const reg = registry();
			const original = events(reg.find(FIRST, FIRST_ID)!, "insufficient_quota", outputType);
			const request = register(() => fromEvents(original));
			const actual = await collect(streamSimple(pool(reg), context));
			expect(actual.events).toEqual(original);
			expect(actual.result).toBe(messageFromEvent(original[2]));
			expect(request).toHaveBeenCalledTimes(1);
		},
	);

	test("returns the last member error when every eligible member exhausts", async () => {
		const reg = registry();
		const last = events(reg.find(SECOND, SECOND_ID)!, "Insufficient Balance");
		const request = register((model) =>
			fromEvents(model.provider === FIRST ? events(model, "insufficient_quota") : last),
		);
		const actual = await collect(streamSimple(pool(reg), context));
		expect(actual.events).toEqual([last[1]]);
		expect(actual.result).toBe(messageFromEvent(last[1]));
		expect(request).toHaveBeenCalledTimes(2);
		const exhausted = await streamSimple(pool(reg), context).result();
		expect(exhausted.stopReason).toBe("error");
		expect(exhausted.errorMessage).toContain('Pool "flash": no eligible members');
		expect(request).toHaveBeenCalledTimes(2);
	});

	test("skips exhausted members across requests and refresh, then retries at cooldown expiry", async () => {
		const reg = registry();
		let firstAttempts = 0;
		const handler = (model: Model<Api>) => {
			if (model.provider === FIRST && ++firstAttempts === 1) return fromEvents(events(model, "insufficient_quota"));
			return fromEvents(events(model));
		};
		let request = register(handler);
		expect((await streamSimple(pool(reg), context).result()).provider).toBe(SECOND);
		now += POOL_EXHAUSTION_COOLDOWN_MS - 1;
		reg.refresh();
		request = register(handler);
		expect((await streamSimple(pool(reg), context).result()).provider).toBe(SECOND);
		expect(request.mock.calls.map(([model]) => model.provider)).toEqual([SECOND]);
		now += 1;
		expect((await streamSimple(pool(reg), context).result()).provider).toBe(FIRST);
		expect(request.mock.calls.map(([model]) => model.provider)).toEqual([SECOND, FIRST]);
	});

	test("skips members without auth and members whose auth cannot resolve", async () => {
		vi.stubEnv("PI_TEST_POOL_MISSING_HEADER", undefined);
		const reg = registry({
			[FIRST]: {
				...provider(FIRST_ID),
				apiKey: undefined,
				headers: { "X-Member": "$PI_TEST_POOL_MISSING_HEADER" },
			},
			[SECOND]: provider(SECOND_ID),
		});
		const request = register((model) => fromEvents(events(model)));
		expect((await streamSimple(pool(reg), context).result()).provider).toBe(SECOND);
		expect(request).toHaveBeenCalledTimes(1);
		auth.set(FIRST, { type: "api_key", key: "fixture-first-key" });
		const firstAuth = await reg.getApiKeyAndHeaders(reg.find(FIRST, FIRST_ID)!);
		expect(firstAuth.ok).toBe(false);
		expect((await streamSimple(pool(reg), context).result()).provider).toBe(SECOND);
		expect(request.mock.calls.map(([model]) => model.provider)).toEqual([SECOND, SECOND]);
	});

	test("names the pool when no member has auth", async () => {
		const reg = registry({
			[FIRST]: { ...provider(FIRST_ID), apiKey: undefined },
			[SECOND]: { ...provider(SECOND_ID), apiKey: undefined },
		});
		const request = register((model) => fromEvents(events(model)));
		const result = await streamSimple(pool(reg), context).result();
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: 'Pool "flash": no eligible members available.',
		});
		expect(request).not.toHaveBeenCalled();
	});

	test("buffers start until output begins, then forwards events before completion", async () => {
		const reg = registry();
		const member = reg.find(FIRST, FIRST_ID)!;
		const partial = message(member);
		const start: AssistantMessageEvent = { type: "start", partial };
		const text: AssistantMessageEvent = { type: "text_delta", contentIndex: 0, delta: "Hello", partial };
		const waiting = createAssistantMessageEventStream();
		let started!: () => void;
		const didStart = new Promise<void>((resolve) => {
			started = resolve;
		});
		register(() => {
			waiting.push(start);
			started();
			return waiting;
		});
		const received: AssistantMessageEvent[] = [];
		let sawText!: () => void;
		const didSeeText = new Promise<void>((resolve) => {
			sawText = resolve;
		});
		const response = streamSimple(pool(reg), context);
		const consume = (async () => {
			for await (const event of response) {
				received.push(event);
				if (event.type === "text_delta") sawText();
			}
		})();
		await didStart;
		await Promise.resolve();
		expect(received).toEqual([]);
		waiting.push(text);
		await didSeeText;
		expect(received).toEqual([start, text]);
		expect(received[0]).toBe(start);
		expect(received[1]).toBe(text);
		waiting.push({ type: "done", reason: "stop", message: partial });
		waiting.end();
		await consume;
		expect(await response.result()).toBe(partial);
	});

	test("rebuilds membership for extension models and re-registers both APIs after refresh", async () => {
		const reg = registry({}, { flash: [`${FIRST}/${FIRST_ID}`] });
		expect(reg.getError()).toContain('Pool "flash"');
		const request = vi.fn((model: Model<Api>) => fromEvents(events(model)));
		reg.registerProvider(FIRST, { ...provider(FIRST_ID), streamSimple: request });
		expect(reg.getError()).toBeUndefined();
		expect((await streamSimple(pool(reg), context).result()).provider).toBe(FIRST);
		reg.refresh();
		expect(reg.getError()).toBeUndefined();
		expect((await streamSimple(pool(reg), context).result()).provider).toBe(FIRST);
		expect(request).toHaveBeenCalledTimes(2);
		reg.unregisterProvider(FIRST);
		expect(reg.find("pool", "flash")).toBeUndefined();
		expect(reg.getError()).toContain('Pool "flash"');
	});

	test("shares cooldowns by real member across pools, not across registry instances", async () => {
		const reg = registry(undefined, {
			flash: [`${FIRST}/${FIRST_ID}`, `${SECOND}/${SECOND_ID}`],
			other: [`${FIRST}/${FIRST_ID}`, `${SECOND}/${SECOND_ID}`],
		});
		const request = register((model) =>
			fromEvents(events(model, model.provider === FIRST ? "insufficient_quota" : undefined)),
		);
		await streamSimple(pool(reg), context).result();
		expect((await streamSimple(reg.find("pool", "other")!, context).result()).provider).toBe(SECOND);
		expect(request.mock.calls.map(([model]) => model.provider)).toEqual([FIRST, SECOND, SECOND]);
		const independent = ModelRegistry.create(auth, modelsPath, () => now);
		await streamSimple(pool(independent), context).result();
		expect(request.mock.calls.map(([model]) => model.provider)).toEqual([FIRST, SECOND, SECOND, FIRST, SECOND]);
	});

	test("returns the last quota error even if later members have no auth", async () => {
		const reg = registry({ [FIRST]: provider(FIRST_ID), [SECOND]: { ...provider(SECOND_ID), apiKey: undefined } });
		const original = events(reg.find(FIRST, FIRST_ID)!, "Insufficient Balance");
		const request = register(() => fromEvents(original));
		const actual = await collect(streamSimple(pool(reg), context));
		expect(actual.events).toEqual([original[1]]);
		expect(actual.result).toBe(messageFromEvent(original[1]));
		expect(request).toHaveBeenCalledTimes(1);
	});

	test("matches exact identities and members of the selected pool only", () => {
		const reg = registry();
		const selected = pool(reg);
		expect(reg.isMessageFromModel({ provider: FIRST, model: FIRST_ID }, selected)).toBe(true);
		expect(reg.isMessageFromModel({ provider: SECOND, model: SECOND_ID }, selected)).toBe(true);
		expect(reg.isMessageFromModel({ provider: "pool", model: "flash" }, selected)).toBe(true);
		expect(reg.isMessageFromModel({ provider: FIRST, model: SECOND_ID }, selected)).toBe(false);
		expect(reg.isMessageFromModel({ provider: "unrelated", model: FIRST_ID }, selected)).toBe(false);
		const first = reg.find(FIRST, FIRST_ID)!;
		expect(reg.isMessageFromModel({ provider: FIRST, model: FIRST_ID }, first)).toBe(true);
		expect(reg.isMessageFromModel({ provider: SECOND, model: SECOND_ID }, first)).toBe(false);
	});

	test("honors a pre-aborted signal without attempting members", async () => {
		const reg = registry();
		const request = register((model) => fromEvents(events(model)));
		const controller = new AbortController();
		controller.abort();
		const actual = await collect(streamSimple(pool(reg), context, { signal: controller.signal }));
		expect(actual.result.stopReason).toBe("aborted");
		expect(request).not.toHaveBeenCalled();
	});

	test("aborts while waiting for member output without rotating or waiting for the member", async () => {
		const reg = registry();
		const waiting = createAssistantMessageEventStream();
		let started!: () => void;
		const didStart = new Promise<void>((resolve) => {
			started = resolve;
		});
		const request = register(() => {
			started();
			return waiting;
		});
		const controller = new AbortController();
		const pending = collect(streamSimple(pool(reg), context, { signal: controller.signal }));
		await didStart;
		controller.abort();
		const actual = await pending;
		expect(actual.result).toMatchObject({
			stopReason: "aborted",
			provider: FIRST,
			model: FIRST_ID,
			api: "pool-test",
		});
		expect(request).toHaveBeenCalledTimes(1);
		waiting.end();
	});

	test("aborts during auth resolution and never starts a member", async () => {
		const reg = registry();
		let resolveAuth!: (value: { ok: true; apiKey: string }) => void;
		vi.spyOn(reg, "getApiKeyAndHeaders").mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveAuth = resolve;
				}),
		);
		const request = register((model) => fromEvents(events(model)));
		const controller = new AbortController();
		const pending = collect(streamSimple(pool(reg), context, { signal: controller.signal }));
		controller.abort();
		expect((await pending).result.stopReason).toBe("aborted");
		resolveAuth({ ok: true, apiKey: "unused-key" });
		await Promise.resolve();
		expect(request).not.toHaveBeenCalled();
	});

	test("routes each pool through the registry that loaded it, even after another registry loads", async () => {
		const first = registry(undefined, { flash: [`${FIRST}/${FIRST_ID}`] });
		const firstPool = pool(first);
		const second = registry(undefined, { flash: [`${SECOND}/${SECOND_ID}`] });
		const request = register((model, _ctx, options) => {
			expect(options?.apiKey).toBe(`fixture-key-${model.id}`);
			return fromEvents(events(model));
		});
		expect((await streamSimple(firstPool, context).result()).provider).toBe(FIRST);
		expect((await streamSimple(pool(second), context).result()).provider).toBe(SECOND);
		expect(request.mock.calls.map(([model]) => model.provider)).toEqual([FIRST, SECOND]);
	});

	test("resolves each attempted member's auth exactly once", async () => {
		const reg = registry();
		const resolveAuth = vi.spyOn(reg, "getApiKeyAndHeaders");
		register((model) => fromEvents(events(model, model.provider === FIRST ? "insufficient_quota" : undefined)));
		expect((await streamSimple(pool(reg), context).result()).provider).toBe(SECOND);
		expect(resolveAuth.mock.calls.map(([model]) => model.provider)).toEqual([FIRST, SECOND]);
	});

	test("ends with an error when a member stream finishes without done or error", async () => {
		const reg = registry();
		const request = register((model) => fromEvents([{ type: "start", partial: message(model) }]));
		const result = await streamSimple(pool(reg), context).result();
		expect(result).toMatchObject({ provider: FIRST, model: FIRST_ID, stopReason: "error" });
		expect(result.errorMessage).toBe(`${FIRST}/${FIRST_ID}: provider stream ended without a final event.`);
		expect(request).toHaveBeenCalledTimes(1);
	});

	test("returns a thrown member error without trying other members", async () => {
		const reg = registry();
		const request = register(() => {
			throw new Error("socket closed");
		});
		const result = await streamSimple(pool(reg), context).result();
		expect(result).toMatchObject({ provider: FIRST, stopReason: "error", errorMessage: "socket closed" });
		expect(request).toHaveBeenCalledTimes(1);
	});
});

function messageFromEvent(event: AssistantMessageEvent): AssistantMessage {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	throw new Error(`Expected terminal event, got ${event.type}`);
}
