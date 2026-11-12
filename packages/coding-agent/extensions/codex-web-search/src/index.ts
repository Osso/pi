import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Api, type Context, type Model, streamSimple } from "@earendil-works/pi-ai/compat";
import { type Static, Type } from "typebox";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "../../../src/core/extensions/types.ts";

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
	// Decide from the request's model: in a pool session ctx.model is the pool, not the serving member.
	pi.on("before_provider_request", (event) => {
		if (isOpenAIHostedWebSearchModel(event.model)) return addWebSearchToolToPayload(event.payload);
		if (event.model?.api === "anthropic-messages") return addAnthropicWebSearchToolToPayload(event.payload);
		return undefined;
	});
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

	const signal = request.signal
		? AbortSignal.any([request.signal, timeoutController.signal])
		: timeoutController.signal;
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
		systemPrompt:
			"You are a web search tool. Search the web and return concise, source-backed findings for the query.",
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

/** How one provider API spells Pi's client web_search tool and its server-side replacement. */
interface HostedSearchSpec {
	isClientTool: (tool: unknown) => boolean;
	isHostedTool: (tool: unknown) => boolean;
	hostedTool: unknown;
}

const ANTHROPIC_WEB_SEARCH_TYPE = "web_search_20250305";
const ANTHROPIC_SERVER_TOOL_PREFIX = "web_search_2";
const ANTHROPIC_MAX_SEARCHES_PER_REQUEST = 5;

const OPENAI_SEARCH: HostedSearchSpec = {
	isClientTool: isFunctionWebSearchTool,
	isHostedTool: isHostedWebSearchTool,
	hostedTool: createWebSearchTool(),
};

/**
 * Anthropic runs web search server-side inside the Messages request. Pi's stream parser skips
 * the resulting server_tool_use / web_search_tool_result blocks and keeps the cited answer text.
 */
const ANTHROPIC_SEARCH: HostedSearchSpec = {
	isClientTool: isAnthropicClientWebSearchTool,
	isHostedTool: isAnthropicServerWebSearchTool,
	hostedTool: { type: ANTHROPIC_WEB_SEARCH_TYPE, name: "web_search", max_uses: ANTHROPIC_MAX_SEARCHES_PER_REQUEST },
};

export function addWebSearchToolToPayload(payload: unknown): unknown | undefined {
	return replaceClientWebSearchTool(payload, OPENAI_SEARCH);
}

export function addAnthropicWebSearchToolToPayload(payload: unknown): unknown | undefined {
	return replaceClientWebSearchTool(payload, ANTHROPIC_SEARCH);
}

/** Swaps Pi's client web_search for the provider's hosted search; undefined when unchanged. */
function replaceClientWebSearchTool(payload: unknown, spec: HostedSearchSpec): unknown | undefined {
	if (!isRecord(payload)) return undefined;

	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	const withoutClientTool = tools.filter((tool) => !spec.isClientTool(tool));
	if (withoutClientTool.some(spec.isHostedTool)) {
		const removedClientTool = withoutClientTool.length !== tools.length;
		return removedClientTool ? ({ ...payload, tools: withoutClientTool } satisfies PayloadWithTools) : undefined;
	}

	return { ...payload, tools: [...withoutClientTool, spec.hostedTool] } satisfies PayloadWithTools;
}

function isAnthropicServerWebSearchTool(value: unknown): boolean {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	return value.type.startsWith(ANTHROPIC_SERVER_TOOL_PREFIX);
}

/** Pi's own web_search sent as an Anthropic custom tool (no type, or type "custom"). */
function isAnthropicClientWebSearchTool(value: unknown): boolean {
	if (!isRecord(value) || value.name !== "web_search") return false;
	const isCustomTool = value.type === undefined || value.type === "custom";
	return isCustomTool;
}

function createWebSearchTool(): WebSearchTool {
	return { type: "web_search", external_web_access: true };
}

function isHostedWebSearchTool(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return value.type === "web_search" || value.type === "web_search_2025_08_26";
}

function isFunctionWebSearchTool(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return value.type === "function" && value.name === "web_search";
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
