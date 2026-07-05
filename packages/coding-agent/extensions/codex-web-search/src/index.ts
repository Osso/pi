import { type Api, type Context, type Model, streamSimple } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "../../../src/core/extensions/types.ts";

interface WebSearchTool {
	type: "web_search";
	external_web_access: true;
}

interface PayloadWithTools extends Record<string, unknown> {
	tools?: unknown[];
}

interface WebSearchRequest {
	query: string;
	model: OpenAIWebSearchModel;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	signal?: AbortSignal;
}

type OpenAIWebSearchApi = "openai-responses" | "openai-codex-responses";
type OpenAIWebSearchModel = Model<OpenAIWebSearchApi>;
type RunWebSearch = (request: WebSearchRequest, ctx: ExtensionContext) => Promise<string>;

const DEFAULT_WEB_SEARCH_TIMEOUT_MS = 180_000;

const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query to send to the web search provider." }),
});

type WebSearchInput = Static<typeof webSearchSchema>;

export default function codexWebSearchExtension(pi: ExtensionAPI) {
	pi.registerTool(createWebSearchToolDefinition());
}

export function createWebSearchToolDefinition(options?: {
	runSearch?: RunWebSearch;
	timeoutMs?: number;
}): ToolDefinition<typeof webSearchSchema> {
	const runSearch = options?.runSearch ?? runHostedWebSearch;
	const timeoutMs = options?.timeoutMs ?? DEFAULT_WEB_SEARCH_TIMEOUT_MS;
	return {
		name: "web_search",
		label: "Web Search",
		description: "Search the web using OpenAI Responses hosted web search and return a concise result summary.",
		promptSnippet: "Search the web for current or external information.",
		promptGuidelines: [
			"Use web_search when the user asks for current, external, or source-backed information that is not available in the repo or local context.",
			"Do not use web_search for codebase investigation; use local file/search tools first.",
		],
		approvalRequired: true,
		parameters: webSearchSchema,
		async execute(_toolCallId, params: WebSearchInput, signal, _onUpdate, ctx): Promise<AgentToolResult<undefined>> {
			const text = await executeWebSearch(params, ctx, signal, runSearch, timeoutMs);
			return { content: [{ type: "text", text }], details: undefined };
		},
	};
}

export function isOpenAIHostedWebSearchModel(model: Model<Api> | undefined): model is OpenAIWebSearchModel {
	return model?.api === "openai-responses" || model?.api === "openai-codex-responses";
}

async function executeWebSearch(
	params: WebSearchInput,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	runSearch: RunWebSearch,
	timeoutMs: number,
): Promise<string> {
	const query = params.query.trim();
	if (!query) throw new Error("web_search query is required");
	if (!isOpenAIHostedWebSearchModel(ctx.model)) {
		throw new Error("web_search requires an OpenAI Responses model");
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok) throw new Error(auth.error);

	return runSearchWithTimeout(
		{
			query,
			model: ctx.model,
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			signal,
		},
		ctx,
		runSearch,
		timeoutMs,
	);
}

async function runSearchWithTimeout(
	request: WebSearchRequest,
	ctx: ExtensionContext,
	runSearch: RunWebSearch,
	timeoutMs: number,
): Promise<string> {
	const timeoutController = new AbortController();
	const timeout = setTimeout(() => {
		timeoutController.abort(new Error(`OpenAI hosted web_search timed out after ${formatTimeout(timeoutMs)}`));
	}, timeoutMs);
	timeout.unref?.();

	const signal = request.signal ? AbortSignal.any([request.signal, timeoutController.signal]) : timeoutController.signal;
	try {
		throwIfAborted(signal);
		return await waitForWebSearch(runSearch({ ...request, signal }, ctx), signal);
	} finally {
		clearTimeout(timeout);
	}
}

function waitForWebSearch(promise: Promise<string>, signal: AbortSignal): Promise<string> {
	if (signal.aborted) return Promise.reject(toAbortError(signal.reason));

	return new Promise<string>((resolve, reject) => {
		const abort = () => reject(toAbortError(signal.reason));
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw toAbortError(signal.reason);
}

function toAbortError(reason: unknown): Error {
	if (reason instanceof Error) return reason;
	return new Error("OpenAI hosted web_search aborted");
}

function formatTimeout(timeoutMs: number): string {
	return timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}s` : `${timeoutMs}ms`;
}

async function runHostedWebSearch(request: WebSearchRequest): Promise<string> {
	const context: Context = {
		systemPrompt: "You are a web search tool. Search the web and return concise, source-backed findings for the query.",
		messages: [{ role: "user", content: request.query, timestamp: Date.now() }],
	};
	const stream = streamSimple(request.model, context, {
		apiKey: request.apiKey,
		headers: request.headers,
		env: request.env,
		signal: request.signal,
		onPayload: (payload) => addWebSearchToolToPayload(payload),
	});
	const message = await stream.result();
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		throw new Error(message.errorMessage ?? "OpenAI hosted web search failed");
	}
	return extractText(message);
}

export function addWebSearchToolToPayload(payload: unknown): unknown | undefined {
	if (!isRecord(payload)) return undefined;

	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	if (tools.some(isHostedWebSearchTool)) return undefined;

	return {
		...payload,
		tools: [...tools, createWebSearchTool()],
	} satisfies PayloadWithTools;
}

function createWebSearchTool(): WebSearchTool {
	return { type: "web_search", external_web_access: true };
}

function isHostedWebSearchTool(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return value.type === "web_search" || value.type === "web_search_2025_08_26";
}

function isRecord(value: unknown): value is PayloadWithTools {
	return typeof value === "object" && value !== null;
}

function extractText(message: AssistantMessage): string {
	const text = message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	if (!text) throw new Error("OpenAI hosted web search returned no text");
	return text;
}
