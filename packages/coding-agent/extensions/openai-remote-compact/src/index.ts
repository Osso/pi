import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type {
	BeforeProviderRequestEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "../../../src/core/extensions/types.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import type { CompactionEntry, SessionEntry } from "../../../src/core/session-manager.ts";

export const OPENAI_REMOTE_COMPACTION_SUMMARY = "OpenAI native compaction stored in session entry details.";
const DETAILS_TYPE = "openai-remote-compaction";
const DETAILS_VERSION = 1;

type OpenAINativeCompactApi = "openai-responses" | "openai-codex-responses";
type OpenAINativeCompactModel = Model<OpenAINativeCompactApi>;

export interface OpenAIRemoteCompactionDetails {
	type: typeof DETAILS_TYPE;
	version: typeof DETAILS_VERSION;
	provider: string;
	model: string;
	endpoint: string;
	replacementHistory: OpenAIResponseItem[];
}

interface OpenAICompactPayload {
	model: string;
	input: OpenAIResponseItem[];
	instructions: string;
	tools: unknown[];
	parallel_tool_calls: boolean;
}

interface OpenAICompactResponse {
	output?: unknown;
}

type OpenAIResponseItem = Record<string, unknown>;

interface OpenAITextPart extends Record<string, unknown> {
	type: "input_text" | "output_text";
	text: string;
}

export default function openAIRemoteCompactExtension(pi: ExtensionAPI) {
	pi.on("session_before_compact", handleSessionBeforeCompact);
	pi.on("before_provider_request", handleBeforeProviderRequest);
}

async function handleSessionBeforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext) {
	const model = ctx.model;
	if (!isOpenAIResponsesModel(model)) return;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		ctx.ui.notify(`OpenAI remote compaction auth failed: ${auth.error}`, "warning");
		return;
	}

	const endpoint = buildCompactEndpoint(model);
	const previousReplacementHistory = findLatestOpenAIReplacementHistory(event.branchEntries);
	const messages = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
	const payload = buildOpenAICompactPayload(model, messages, ctx.getSystemPrompt(), previousReplacementHistory);
	const response = await postOpenAICompact(endpoint, payload, model, auth.apiKey, auth.headers, event.signal);
	const details = extractOpenAICompactDetails(model, response, endpoint);

	return {
		compaction: {
			summary: OPENAI_REMOTE_COMPACTION_SUMMARY,
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
			details,
		},
	};
}

function handleBeforeProviderRequest(event: BeforeProviderRequestEvent, ctx: ExtensionContext) {
	if (!isOpenAIResponsesModel(ctx.model)) return undefined;
	const entries = ctx.sessionManager.getEntries();
	return rewriteOpenAICompactionPayload(event.payload, entries);
}

export function isOpenAIResponsesModel(model: Model<Api> | undefined): model is OpenAINativeCompactModel {
	if (model?.provider === "openai" && model.api === "openai-responses") return true;
	return isOpenAICodexResponsesModel(model);
}

function isOpenAICodexResponsesModel(model: Model<Api> | undefined): model is OpenAINativeCompactModel {
	return (
		(model?.provider === "openai-codex" || model?.provider === "openai-codex-gc") &&
		model.api === "openai-codex-responses"
	);
}

export function buildOpenAICompactPayload(
	model: OpenAINativeCompactModel,
	messages: AgentMessage[],
	instructions: string,
	previousReplacementHistory: OpenAIResponseItem[],
): OpenAICompactPayload {
	return {
		model: model.id,
		input: [...previousReplacementHistory, ...convertAgentMessagesToOpenAIResponseItems(model, messages)],
		instructions,
		tools: [],
		parallel_tool_calls: false,
	};
}

export function extractOpenAICompactDetails(
	model: OpenAINativeCompactModel,
	response: OpenAICompactResponse,
	endpoint: string,
): OpenAIRemoteCompactionDetails {
	if (!Array.isArray(response.output)) {
		throw new Error("OpenAI compact response did not include an output array");
	}
	const replacementHistory = response.output.filter(isRecord);
	if (!replacementHistory.some(isOpenAICompactionItem)) {
		throw new Error("OpenAI compact response did not include a compaction item");
	}
	return {
		type: DETAILS_TYPE,
		version: DETAILS_VERSION,
		provider: model.provider,
		model: model.id,
		endpoint,
		replacementHistory,
	};
}

export function rewriteOpenAICompactionPayload(payload: unknown, entries: SessionEntry[]): unknown {
	if (!isRecord(payload) || !Array.isArray(payload.input)) return undefined;
	const details = findLatestOpenAIReplacementHistoryDetails(entries);
	if (!details) return undefined;

	let replaced = false;
	const input = payload.input.flatMap((item): unknown[] => {
		if (isSyntheticOpenAICompactionSummaryItem(item)) {
			replaced = true;
			return details.replacementHistory;
		}
		return [item];
	});

	return replaced ? { ...payload, input } : undefined;
}

async function postOpenAICompact(
	endpoint: string,
	payload: OpenAICompactPayload,
	model: OpenAINativeCompactModel,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	signal: AbortSignal,
): Promise<OpenAICompactResponse> {
	const requestHeaders = buildOpenAIRequestHeaders(model, apiKey, headers);
	const response = await fetch(endpoint, {
		method: "POST",
		headers: requestHeaders,
		body: JSON.stringify(payload),
		signal,
	});
	const body = await parseOpenAICompactResponse(response);
	if (!response.ok) {
		throw new Error(`OpenAI remote compaction failed (${response.status}): ${formatOpenAIError(body)}`);
	}
	return body;
}

export function buildCompactEndpoint(model: OpenAINativeCompactModel): string {
	if (model.api === "openai-codex-responses") return `${resolveCodexResponsesEndpoint(model.baseUrl)}/compact`;
	return `${model.baseUrl.replace(/\/+$/, "")}/responses/compact`;
}

export function buildOpenAIRequestHeaders(
	model: OpenAINativeCompactModel,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
) {
	const requestHeaders: Record<string, string> = { ...headers, "content-type": "application/json" };
	const hasAuthorization = Object.keys(requestHeaders).some((name) => name.toLowerCase() === "authorization");
	if (apiKey && !hasAuthorization) requestHeaders.Authorization = `Bearer ${apiKey}`;
	if (apiKey && model.api === "openai-codex-responses") {
		requestHeaders["chatgpt-account-id"] = extractCodexAccountId(apiKey);
		requestHeaders.originator = "pi";
		requestHeaders["OpenAI-Beta"] = "responses=experimental";
	}
	return requestHeaders;
}

function resolveCodexResponsesEndpoint(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function extractCodexAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Invalid token");
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
		const auth = isRecord(payload) ? payload["https://api.openai.com/auth"] : undefined;
		const accountId = isRecord(auth) ? auth.chatgpt_account_id : undefined;
		if (typeof accountId !== "string" || accountId.length === 0) throw new Error("No account ID in token");
		return accountId;
	} catch {
		throw new Error("Failed to extract accountId from Codex token");
	}
}

async function parseOpenAICompactResponse(response: Response): Promise<OpenAICompactResponse> {
	const text = await response.text();
	if (text.length === 0) return {};
	try {
		return JSON.parse(text) as OpenAICompactResponse;
	} catch {
		return { output: [{ type: "error", text }] };
	}
}

function formatOpenAIError(body: OpenAICompactResponse): string {
	const error = isRecord(body) ? body.error : undefined;
	if (isRecord(error) && typeof error.message === "string") return error.message;
	return JSON.stringify(body);
}

function findLatestOpenAIReplacementHistory(entries: SessionEntry[]): OpenAIResponseItem[] {
	return findLatestOpenAIReplacementHistoryDetails(entries)?.replacementHistory ?? [];
}

function findLatestOpenAIReplacementHistoryDetails(entries: SessionEntry[]): OpenAIRemoteCompactionDetails | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "compaction" && isOpenAIRemoteCompactionDetails(entry.details)) return entry.details;
	}
	return undefined;
}

function isOpenAIRemoteCompactionDetails(value: unknown): value is OpenAIRemoteCompactionDetails {
	return (
		isRecord(value) &&
		value.type === DETAILS_TYPE &&
		value.version === DETAILS_VERSION &&
		typeof value.provider === "string" &&
		typeof value.model === "string" &&
		typeof value.endpoint === "string" &&
		Array.isArray(value.replacementHistory) &&
		value.replacementHistory.every(isRecord)
	);
}

function isSyntheticOpenAICompactionSummaryItem(value: unknown): boolean {
	if (!isRecord(value) || value.role !== "user" || !Array.isArray(value.content)) return false;
	return value.content.some((part) => isInputTextPart(part) && part.text.includes(OPENAI_REMOTE_COMPACTION_SUMMARY));
}

function isOpenAICompactionItem(value: unknown): boolean {
	return isRecord(value) && value.type === "compaction" && typeof value.encrypted_content === "string";
}

function convertAgentMessagesToOpenAIResponseItems(
	model: OpenAINativeCompactModel,
	messages: AgentMessage[],
): OpenAIResponseItem[] {
	return convertToLlm(messages).flatMap((message): OpenAIResponseItem[] => {
		if (message.role === "user") return convertUserMessage(message.content);
		if (message.role === "assistant") return convertAssistantMessage(message.content);
		if (message.role === "toolResult") return [convertToolResultMessage(message.toolCallId, message.content, model)];
		return [];
	});
}

function convertUserMessage(content: string | Array<TextContent | ImageContent>): OpenAIResponseItem[] {
	const convertedContent = typeof content === "string" ? [inputText(content)] : content.map(convertUserContentPart);
	return convertedContent.length > 0 ? [{ role: "user", content: convertedContent }] : [];
}

function convertUserContentPart(content: TextContent | ImageContent): OpenAIResponseItem {
	if (content.type === "text") return inputText(content.text);
	return {
		type: "input_image",
		detail: "auto",
		image_url: `data:${content.mimeType};base64,${content.data}`,
	};
}

function convertAssistantMessage(content: AssistantMessage["content"]): OpenAIResponseItem[] {
	const output: OpenAIResponseItem[] = [];
	for (const block of content) {
		if (block.type === "text") {
			output.push({
				type: "message",
				role: "assistant",
				content: [outputText(block.text)],
				status: "completed",
			});
		} else if (block.type === "toolCall") {
			const [callId, itemId] = block.id.split("|");
			output.push({
				type: "function_call",
				id: itemId,
				call_id: callId,
				name: block.name,
				arguments: JSON.stringify(block.arguments),
			});
		}
	}
	return output;
}

function convertToolResultMessage(
	toolCallId: string,
	content: Array<TextContent | ImageContent>,
	model: OpenAINativeCompactModel,
): OpenAIResponseItem {
	const [callId] = toolCallId.split("|");
	const text = content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const images = content.filter((part): part is ImageContent => part.type === "image");
	if (images.length === 0 || !model.input.includes("image")) {
		return { type: "function_call_output", call_id: callId, output: text || "(see attached image)" };
	}
	return {
		type: "function_call_output",
		call_id: callId,
		output: [
			...(text ? [inputText(text)] : []),
			...images.map((image) => ({
				type: "input_image",
				detail: "auto",
				image_url: `data:${image.mimeType};base64,${image.data}`,
			})),
		],
	};
}

function inputText(text: string): OpenAITextPart {
	return { type: "input_text", text };
}

function outputText(text: string): OpenAITextPart {
	return { type: "output_text", text };
}

function isInputTextPart(value: unknown): value is { type: "input_text"; text: string } {
	return isRecord(value) && value.type === "input_text" && typeof value.text === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
