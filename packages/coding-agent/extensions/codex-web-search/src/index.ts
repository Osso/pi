import { type Api, type Context, type Model, streamSimple } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "../../../src/core/extensions/types.ts";

interface WebSearchTool {
	type: "web_search";
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

const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query to send to the web search provider." }),
});

type WebSearchInput = Static<typeof webSearchSchema>;

export default function codexWebSearchExtension(pi: ExtensionAPI) {
	pi.registerTool(createWebSearchToolDefinition());
}

export function createWebSearchToolDefinition(options?: { runSearch?: RunWebSearch }): ToolDefinition<typeof webSearchSchema> {
	const runSearch = options?.runSearch ?? runHostedWebSearch;
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
			const query = params.query.trim();
			if (!query) throw new Error("web_search query is required");
			if (!isOpenAIHostedWebSearchModel(ctx.model)) {
				throw new Error("web_search requires an OpenAI Responses model");
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
			if (!auth.ok) throw new Error(auth.error);

			const text = await runSearch(
				{
					query,
					model: ctx.model,
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					signal,
				},
				ctx,
			);
			return { content: [{ type: "text", text }], details: undefined };
		},
	};
}

export function isOpenAIHostedWebSearchModel(model: Model<Api> | undefined): model is OpenAIWebSearchModel {
	return model?.api === "openai-responses" || model?.api === "openai-codex-responses";
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
	return { type: "web_search" };
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
