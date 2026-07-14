import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type {
	CompactionEvent,
	ExtensionAPI,
	ExtensionContext,
} from "../../../src/core/extensions/types.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";

export const OPENAI_REMOTE_COMPACTION_SUMMARY = "OpenAI native compaction stored in session entry details.";
const DETAILS_TYPE = "openai-remote-compaction";
const DETAILS_VERSION = 1;
const MAX_OPENAI_REMOTE_COMPACT_CONTEXT_CHARS = 400_000;
const CODEX_REMOTE_COMPACTION_MODEL = "gpt-5.6-terra";

type OpenAINativeCompactApi = "openai-responses" | "openai-codex-responses";
type OpenAINativeCompactModel = Model<OpenAINativeCompactApi>;

export interface OpenAIRemoteCompactionDetails {
	type: typeof DETAILS_TYPE;
	version: typeof DETAILS_VERSION;
	provider: string;
	api: OpenAINativeCompactApi;
	model: string;
	endpoint: string;
	replacementHistory: OpenAIResponseItem[];
	replacementHistoryBytes: number;
	replacementHistoryTokens: number;
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
	pi.on("compaction", handleCompaction);
}

export async function handleCompaction(event: CompactionEvent, ctx: ExtensionContext) {
	const model = ctx.model;
	if (!isOpenAIResponsesModel(model)) return;

	const previousReplacementHistory = findLatestOpenAIReplacementHistory(event.branchEntries, model);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		ctx.ui.notify(`OpenAI remote compaction auth failed: ${auth.error}`, "warning");
		return;
	}

	const endpoint = buildCompactEndpoint(model);
	const messages = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
	const payload = buildOpenAICompactPayload(model, messages, ctx.getSystemPrompt(), previousReplacementHistory);
	const startedAt = Date.now();
	const response = await postOpenAICompact(endpoint, payload, model, auth.apiKey, auth.headers, event.signal);
	const durationMs = Date.now() - startedAt;
	const details = extractOpenAICompactDetails(model, response, endpoint);

	return {
		compaction: {
			summary: OPENAI_REMOTE_COMPACTION_SUMMARY,
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
			durationMs,
			compactedResultBytes: details.replacementHistoryBytes,
			compactedResultTokens: details.replacementHistoryTokens,
			source: { type: "openai_remote" as const, provider: model.provider, model: model.id, endpoint },
			providerNative: {
				provider: model.provider,
				api: model.api,
				format: "openai.responses.input" as const,
				value: details.replacementHistory,
			},
			details,
		},
	};
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

function isCodexRemoteCompactionModel(model: OpenAINativeCompactModel): boolean {
	return (
		model.api === "openai-codex-responses" &&
		(model.provider === "openai-codex" || model.provider === "openai-codex-gc")
	);
}

function getOpenAICompactModelId(model: OpenAINativeCompactModel): string {
	return isCodexRemoteCompactionModel(model) ? CODEX_REMOTE_COMPACTION_MODEL : model.id;
}

export function buildOpenAICompactPayload(
	model: OpenAINativeCompactModel,
	messages: AgentMessage[],
	instructions: string,
	previousReplacementHistory: OpenAIResponseItem[],
): OpenAICompactPayload {
	const convertedMessages = convertAgentMessagesToOpenAIResponseItems(model, messages);
	const reconciledMessages = reconcileOpenAIToolPairs(convertedMessages);
	const previousHistoryFits =
		serializedOpenAIInputChars(previousReplacementHistory) <= MAX_OPENAI_REMOTE_COMPACT_CONTEXT_CHARS;
	const encryptedCompactionItems = previousReplacementHistory.filter(isOpenAICompactionItem);
	const encryptedCompactionItemsFit =
		serializedOpenAIInputChars(encryptedCompactionItems) <= MAX_OPENAI_REMOTE_COMPACT_CONTEXT_CHARS;
	const pinnedPreviousItems = previousHistoryFits
		? previousReplacementHistory
		: encryptedCompactionItemsFit
			? encryptedCompactionItems
			: [];
	const input = limitOpenAICompactInput(
		[...previousReplacementHistory, ...reconciledMessages],
		new Set(pinnedPreviousItems),
		new Set(previousReplacementHistory),
	);
	return {
		model: getOpenAICompactModelId(model),
		input,
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
	const replacementHistoryBytes = Buffer.byteLength(JSON.stringify(replacementHistory), "utf8");
	return {
		type: DETAILS_TYPE,
		version: DETAILS_VERSION,
		provider: model.provider,
		api: model.api,
		model: getOpenAICompactModelId(model),
		endpoint,
		replacementHistory,
		replacementHistoryBytes,
		replacementHistoryTokens: Math.ceil(replacementHistoryBytes / 4),
	};
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

function findLatestOpenAIReplacementHistory(
	entries: SessionEntry[],
	model: OpenAINativeCompactModel,
): OpenAIResponseItem[] {
	const details = findLatestOpenAIReplacementHistoryDetails(entries);
	if (!details || details.provider !== model.provider || details.api !== model.api) return [];
	if (!isCodexRemoteCompactionModel(model) && details.model !== model.id) return [];
	return details.replacementHistory;
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
		(value.api === "openai-responses" || value.api === "openai-codex-responses") &&
		typeof value.model === "string" &&
		typeof value.endpoint === "string" &&
		Array.isArray(value.replacementHistory) &&
		value.replacementHistory.every(isRecord) &&
		(typeof value.replacementHistoryBytes !== "number" || Number.isFinite(value.replacementHistoryBytes)) &&
		(typeof value.replacementHistoryTokens !== "number" || Number.isFinite(value.replacementHistoryTokens))
	);
}

function isOpenAICompactionItem(value: unknown): boolean {
	return (
		isRecord(value) &&
		(value.type === "compaction" || value.type === "compaction_summary") &&
		typeof value.encrypted_content === "string"
	);
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

type OpenAIInputChunk = OpenAIResponseItem[];

export function limitOpenAICompactInput(
	items: OpenAIResponseItem[],
	pinnedItems: ReadonlySet<OpenAIResponseItem> = new Set(),
	nativeItems: ReadonlySet<OpenAIResponseItem> = new Set(),
): OpenAIResponseItem[] {
	if (serializedOpenAIInputChars(items) <= MAX_OPENAI_REMOTE_COMPACT_CONTEXT_CHARS) return items;

	const chunks = groupOpenAIToolBatches(items, nativeItems);
	const limitedChunks = chunks.map((chunk) =>
		chunk.some((item) => pinnedItems.has(item)) ? chunk : undefined,
	);

	for (let index = chunks.length - 1; index >= 0; index--) {
		if (limitedChunks[index]) continue;
		const chunk = chunks[index];
		if (!chunk) continue;
		const reservedItems = limitedChunks.flatMap((selectedChunk) => selectedChunk ?? []);
		if (serializedOpenAIInputChars([...chunk, ...reservedItems]) <= MAX_OPENAI_REMOTE_COMPACT_CONTEXT_CHARS) {
			limitedChunks[index] = chunk;
			continue;
		}

		const reducedChunk = reduceOpenAIChunkToFit(reservedItems, chunk);
		if (reducedChunk) limitedChunks[index] = reducedChunk;
	}
	return limitedChunks.flatMap((chunk) => chunk ?? []);
}

function groupOpenAIToolBatches(
	items: OpenAIResponseItem[],
	nativeItems: ReadonlySet<OpenAIResponseItem>,
): OpenAIInputChunk[] {
	const firstRawItemIndex = items.findIndex((item) => !nativeItems.has(item));
	const nativeHistoryEndIndex = firstRawItemIndex === -1 ? items.length : firstRawItemIndex;
	const chunks: OpenAIInputChunk[] = [];
	let index = 0;
	while (index < items.length) {
		const item = items[index];
		if (!item) {
			index++;
			continue;
		}
		if (!isFunctionCallItem(item)) {
			chunks.push([item]);
			index++;
			continue;
		}

		const regionEndIndex = index < nativeHistoryEndIndex ? nativeHistoryEndIndex : items.length;
		const batchEndIndex = findToolBatchEndIndex(items, index, regionEndIndex);
		chunks.push(items.slice(index, batchEndIndex + 1));
		index = batchEndIndex + 1;
	}
	return chunks;
}

function findToolBatchEndIndex(items: OpenAIResponseItem[], startIndex: number, endIndex: number): number {
	const pendingCallIds = new Set<string>();
	let lastFunctionCallIndex = startIndex;
	for (let index = startIndex; index < endIndex; index++) {
		const item = items[index];
		if (!item) continue;
		if (isFunctionCallItem(item)) {
			pendingCallIds.add(item.call_id);
			lastFunctionCallIndex = index;
			continue;
		}
		if (isFunctionCallOutputItem(item)) {
			pendingCallIds.delete(item.call_id);
			if (pendingCallIds.size === 0) return index;
		}
		if (index > lastFunctionCallIndex && pendingCallIds.size === 0) return lastFunctionCallIndex;
	}
	return lastFunctionCallIndex;
}

function serializedOpenAIInputChars(items: OpenAIResponseItem[]): number {
	return JSON.stringify(items).length;
}

function reduceOpenAIChunkToFit(
	reservedItems: OpenAIResponseItem[],
	chunk: OpenAIInputChunk,
): OpenAIInputChunk | undefined {
	const withoutImages = dropImagePartsFromChunk(chunk);
	if (withoutImages.length === 0) return undefined;
	if (serializedOpenAIInputChars([...withoutImages, ...reservedItems]) <= MAX_OPENAI_REMOTE_COMPACT_CONTEXT_CHARS) {
		return withoutImages;
	}
	return truncateChunkTextToFit(reservedItems, withoutImages);
}

function dropImagePartsFromChunk(chunk: OpenAIInputChunk): OpenAIInputChunk {
	return chunk.flatMap((item) => {
		const itemWithoutImages = dropImagePartsFromItem(item);
		return itemWithoutImages ? [itemWithoutImages] : [];
	});
}

function dropImagePartsFromItem(item: OpenAIResponseItem): OpenAIResponseItem | undefined {
	if (isAtomicOpenAIItem(item)) return item;
	const content = Array.isArray(item.content) ? item.content.filter((part) => !isImagePart(part)) : undefined;
	if (content) return content.length > 0 ? { ...item, content } : undefined;

	const output = Array.isArray(item.output) ? item.output.filter((part) => !isImagePart(part)) : undefined;
	if (output) return output.length > 0 ? { ...item, output } : undefined;

	return item;
}

function isAtomicOpenAIItem(item: OpenAIResponseItem): boolean {
	return item.type === "function_call" || item.type === "compaction" || item.type === "compaction_summary";
}

function isImagePart(value: unknown): boolean {
	return isRecord(value) && value.type === "input_image";
}

function truncateChunkTextToFit(
	reservedItems: OpenAIResponseItem[],
	chunk: OpenAIInputChunk,
): OpenAIInputChunk | undefined {
	const textChars = countReducibleTextChars(chunk);
	let low = 0;
	let high = textChars;
	let best: OpenAIInputChunk | undefined;

	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const candidate = truncateReducibleText(chunk, { remaining: mid });
		if (!Array.isArray(candidate) || !candidate.every(isRecord)) return undefined;
		if (serializedOpenAIInputChars([...candidate, ...reservedItems]) <= MAX_OPENAI_REMOTE_COMPACT_CONTEXT_CHARS) {
			best = candidate;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}

	return best && countReducibleTextChars(best) > 0 ? best : undefined;
}

function countReducibleTextChars(value: unknown): number {
	if (isOpenAITextPart(value)) return value.text.length;
	if (isStringToolOutput(value)) return value.output.length;
	if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + countReducibleTextChars(item), 0);
	if (!isRecord(value) || isAtomicOpenAIItem(value)) return 0;
	return Object.values(value).reduce<number>((sum, item) => sum + countReducibleTextChars(item), 0);
}

function truncateReducibleText(value: unknown, budget: { remaining: number }): unknown {
	if (isOpenAITextPart(value)) {
		const keptChars = Math.min(value.text.length, budget.remaining);
		budget.remaining -= keptChars;
		return { ...value, text: value.text.slice(0, keptChars) };
	}
	if (isStringToolOutput(value)) {
		const keptChars = Math.min(value.output.length, budget.remaining);
		budget.remaining -= keptChars;
		return { ...value, output: value.output.slice(0, keptChars) };
	}
	if (Array.isArray(value)) return value.map((item) => truncateReducibleText(item, budget));
	if (!isRecord(value) || isAtomicOpenAIItem(value)) return value;

	const truncated: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		truncated[key] = truncateReducibleText(item, budget);
	}
	return truncated;
}

function reconcileOpenAIToolPairs(items: OpenAIResponseItem[]): OpenAIResponseItem[] {
	const callIds = new Set<string>();
	const outputCallIds = new Set<string>();
	for (const item of items) {
		if (isFunctionCallItem(item)) callIds.add(item.call_id);
		if (isFunctionCallOutputItem(item)) outputCallIds.add(item.call_id);
	}
	return items.filter((item) => {
		if (isFunctionCallItem(item)) return outputCallIds.has(item.call_id);
		if (isFunctionCallOutputItem(item)) return callIds.has(item.call_id);
		return true;
	});
}

function isFunctionCallItem(item: OpenAIResponseItem): item is OpenAIResponseItem & { call_id: string } {
	return item.type === "function_call" && typeof item.call_id === "string";
}

function isFunctionCallOutputItem(item: OpenAIResponseItem): item is OpenAIResponseItem & { call_id: string } {
	return item.type === "function_call_output" && typeof item.call_id === "string";
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
	if (images.length === 0) {
		return { type: "function_call_output", call_id: callId, output: text };
	}
	if (!model.input.includes("image")) {
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

function isOpenAITextPart(value: unknown): value is OpenAITextPart {
	return (
		isRecord(value) &&
		(value.type === "input_text" || value.type === "output_text") &&
		typeof value.text === "string"
	);
}

function isStringToolOutput(value: unknown): value is OpenAIResponseItem & { output: string } {
	return isRecord(value) && value.type === "function_call_output" && typeof value.output === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
