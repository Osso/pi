import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";

function createErrorMessage(errorMessage: string, provider = "ollama"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider,
		model: "qwen3.5:35b",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("isContextOverflow", () => {
	it("detects explicit Ollama prompt-too-long errors", () => {
		const message = createErrorMessage("400 `prompt too long; exceeded max context length by 100918 tokens`");
		expect(isContextOverflow(message, 32768)).toBe(true);
	});

	it("detects upstream request buffer limit errors as overflow", () => {
		const message = createErrorMessage("Error: exceeded request buffer limit while retrying upstream");
		expect(isContextOverflow(message, 32768)).toBe(true);
	});

	// Upstream #9805, #10208: z.ai and its CN endpoint report overflow as code 1261.
	it.each([
		'400 {"code":"1261","message":"Prompt too long"}',
		'400 {"code":"1261","message":"Prompt exceeds max length"}',
	])("detects z.ai prompt length errors: %s", (errorMessage) => {
		expect(isContextOverflow(createErrorMessage(errorMessage, "zai"), 1048576)).toBe(true);
	});

	it("detects DashScope input length range errors", () => {
		const message = createErrorMessage(
			'400 {"type":"invalid_parameter_error","message":"Range of input length should be [1, 262144]"}',
		);
		expect(isContextOverflow(message, 262144)).toBe(true);
	});

	// Upstream 73f8de80b: Copilot reports request-size overflow as HTTP 413 with a generic body.
	it.each([
		'github-copilot API error (413): {"message":"failed to parse request","code":""}',
		"413 Request Entity Too Large",
	])("detects HTTP 413 request-size overflow: %s", (errorMessage) => {
		expect(isContextOverflow(createErrorMessage(errorMessage))).toBe(true);
	});

	it.each([
		'github-copilot API error (400): {"message":"failed to parse request","code":""}',
		"custom-provider API error (429): Too many requests",
		'github-copilot API error (400): {"message":"failed to parse request: invalid value 413"}',
		"custom-provider API error (4130): invalid input",
		"4130 failed to parse request",
	])("does not mistake unrelated errors for request-size overflow: %s", (errorMessage) => {
		expect(isContextOverflow(createErrorMessage(errorMessage))).toBe(false);
	});

	// Upstream #9482: a bodyless HTTP 400 is only known to mean overflow for Cerebras.
	it("only treats bodyless 400 errors as overflow for Cerebras", () => {
		const errorMessage = "400 status code (no body)";
		expect(isContextOverflow(createErrorMessage(errorMessage, "cerebras"), 131072)).toBe(true);
		expect(isContextOverflow(createErrorMessage(errorMessage, "opencode-go"), 1000000)).toBe(false);
	});

	it("detects Together AI context length errors", () => {
		const message = createErrorMessage(
			"400 The input (516368 tokens) is longer than the model's context length (262144 tokens).",
		);
		expect(isContextOverflow(message, 262144)).toBe(true);
	});

	it("detects LiteLLM-wrapped OpenAI maximum context length errors", () => {
		const message = createErrorMessage(
			"Error: 503 litellm.ServiceUnavailableError: litellm.MidStreamFallbackError: litellm.APIConnectionError: APIConnectionError: OpenAIException - Requested token count exceeds the model's maximum context length of 131072 tokens.",
		);
		expect(isContextOverflow(message, 131072)).toBe(true);
	});

	it("detects LiteLLM pre-call ContextWindowExceededError", () => {
		// Regression for #11492.
		const message = createErrorMessage(
			'400: {"message":"litellm.ContextWindowExceededError: litellm.BadRequestError: litellm._pre_call_checks: Context Window exceeded for given call. No models have context window large enough for this call.\nModel=Qwen3.8-Flash-Next, Max Input Tokens=262144, Got=265262\nmodel=Qwen3.8-Flash-Next. context_window_fallbacks=None. fallbacks=[]."}',
		);
		expect(isContextOverflow(message, 262144)).toBe(true);
	});

	it("detects OpenAI-compatible parenthesized maximum context length errors", () => {
		const message = createErrorMessage(
			"Error: 400 Input length (265330) exceeds model's maximum context length (262144).",
		);
		expect(isContextOverflow(message, 262144)).toBe(true);
	});

	it("detects OpenRouter Poolside maximum allowed input length errors", () => {
		const message = createErrorMessage(
			"Provider returned error: Input length 131393 exceeds the maximum allowed input length of 131040 tokens.",
		);
		expect(isContextOverflow(message, 131072)).toBe(true);
	});

	it("detects DS4 configured context size errors", () => {
		const message = createErrorMessage(
			"400 Prompt has 256468 tokens, but the configured context size is 256000 tokens",
		);
		expect(isContextOverflow(message, 256000)).toBe(true);

		const commaMessage = createErrorMessage(
			"Prompt has 5,958,968 tokens, but the configured context size is 256,000 tokens",
		);
		expect(isContextOverflow(commaMessage, 256000)).toBe(true);
	});

	it("does not treat generic non-overflow Ollama errors as overflow", () => {
		const message = createErrorMessage("500 `model runner crashed unexpectedly`");
		expect(isContextOverflow(message, 32768)).toBe(false);
	});

	it("does not treat Bedrock throttling 'Too many tokens' as overflow", () => {
		// Bedrock returns this for HTTP 429 rate limiting, NOT context overflow.
		// formatBedrockError uses a human-readable prefix for ThrottlingException.
		const message = createErrorMessage("Throttling error: Too many tokens, please wait before trying again.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat Bedrock service unavailable as overflow", () => {
		const message = createErrorMessage("Service unavailable: The service is temporarily unavailable.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat generic rate limit errors as overflow", () => {
		const message = createErrorMessage("Rate limit exceeded, please retry after 30 seconds.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat HTTP 429 style errors as overflow", () => {
		const message = createErrorMessage("Too many requests. Please slow down.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	function createLengthStopMessage(input: number, cacheRead: number, output: number): AssistantMessage {
		return {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "xiaomi",
			model: "mimo-v2.5-pro",
			usage: {
				input,
				output,
				cacheRead,
				cacheWrite: 0,
				totalTokens: input + cacheRead + output,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "length",
			timestamp: Date.now(),
		};
	}

	it("detects Xiaomi-style overflow (length stop with zero output and filled context)", () => {
		const message = createLengthStopMessage(58, 1048512, 0);
		expect(isContextOverflow(message, 1048576)).toBe(true);
	});

	it("does not treat normal length stops with output as overflow", () => {
		const message = createLengthStopMessage(1000, 0, 4096);
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat length stops far below context as overflow", () => {
		const message = createLengthStopMessage(100, 0, 0);
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("counts cache-write tokens as prompt tokens for length and stop overflow", () => {
		const lengthStop = createLengthStopMessage(100, 300, 0);
		lengthStop.usage.cacheWrite = 600;
		expect(isContextOverflow(lengthStop, 1000)).toBe(true);

		const silentStop = createLengthStopMessage(101, 300, 8);
		silentStop.usage.cacheWrite = 600;
		silentStop.stopReason = "stop";
		expect(isContextOverflow(silentStop, 1000)).toBe(true);
	});
});
