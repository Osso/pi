import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "../types.ts";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

function replaceImagesWithPlaceholder(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
	const result: TextContent[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
			}
			previousWasPlaceholder = true;
			continue;
		}

		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}

	return result;
}

function downgradeUnsupportedImages<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	if (model.input.includes("image")) {
		return messages;
	}

	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
			};
		}

		if (msg.role === "toolResult") {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
			};
		}

		return msg;
	});
}

/**
 * Normalize tool call ID for cross-provider compatibility.
 * OpenAI Responses API generates IDs that are 450+ chars with special characters like `|`.
 * Anthropic APIs require IDs matching ^[a-zA-Z0-9_-]+$ (max 64 chars).
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	// Build a map of original tool call IDs to normalized IDs
	const toolCallIdMap = new Map<string, string>();
	const imageAwareMessages = downgradeUnsupportedImages(messages, model);

	// First pass: transform messages (unsupported image downgrade, thinking blocks, tool call ID normalization)
	const transformed = imageAwareMessages.map((msg) => {
		// User messages pass through unchanged
		if (msg.role === "user") {
			return msg;
		}

		// Handle toolResult messages - normalize toolCallId if we have a mapping
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		// Assistant messages need transformation check
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;

			const transformedContent = assistantMsg.content.flatMap((block) => {
				if (block.type === "thinking") {
					// Thinking from another model is dropped. Signatures and encrypted reasoning are
					// only valid for the model that produced them, and sending readable thinking as
					// plain text makes the new model treat it as part of the visible reply.
					if (!isSameModel) return [];
					// Keep redacted and signed blocks even if the thinking text is empty
					// (OpenAI encrypted reasoning); they are needed for replay.
					if (block.redacted || block.thinkingSignature) return block;
					if (!block.thinking || block.thinking.trim() === "") return [];
					return block;
				}

				if (block.type === "text") {
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					let normalizedToolCall: ToolCall = toolCall;

					if (!isSameModel && toolCall.thoughtSignature) {
						normalizedToolCall = { ...toolCall };
						delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
					}

					if (normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
						if (normalizedId !== toolCall.id) {
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
					}

					return normalizedToolCall;
				}

				return block;
			});

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}
		return msg;
	});

	// Second pass: insert synthetic empty tool results for orphaned tool calls
	// This preserves thinking signatures and satisfies API requirements
	const result: Message[] = [];
	// A result stored after the user message that interrupted its batch (and before the next assistant
	// message) moves up to where its call is resolved, so the call gets that one result instead of a
	// synthetic one plus a stray late one. Later results are never taken: providers reuse call ids.
	let lateResults = new Map<string, ToolResultMessage>();
	const movedResults = new Set<ToolResultMessage>();
	let pendingToolCalls: ToolCall[] = [];
	let pendingToolCallIds = new Set<string>();
	let existingToolResultIds = new Set<string>();
	// Results of the pending batch go out in call order: Gemini pairs responses with calls by position.
	let bufferedResults = new Map<string, ToolResultMessage>();
	const flushBufferedResults = () => {
		for (const tc of pendingToolCalls) {
			const buffered = bufferedResults.get(tc.id);
			if (buffered) result.push(buffered);
			bufferedResults.delete(tc.id);
		}
	};
	const insertSyntheticToolResults = () => {
		if (pendingToolCalls.length > 0) {
			for (const tc of pendingToolCalls) {
				const buffered = bufferedResults.get(tc.id);
				bufferedResults.delete(tc.id);
				if (buffered) {
					result.push(buffered);
					continue;
				}
				if (existingToolResultIds.has(tc.id)) continue;
				const lateResult = lateResults.get(tc.id);
				if (lateResult) {
					lateResults.delete(tc.id);
					movedResults.add(lateResult);
					result.push(lateResult);
				} else {
					result.push({
						role: "toolResult",
						toolCallId: tc.id,
						toolName: tc.name,
						content: [{ type: "text", text: "No result provided" }],
						isError: true,
						timestamp: Date.now(),
					} as ToolResultMessage);
				}
			}
			pendingToolCalls = [];
			pendingToolCallIds = new Set();
			existingToolResultIds = new Set();
			bufferedResults = new Map();
		}
	};

	for (const [index, msg] of transformed.entries()) {
		if (msg.role === "assistant") {
			// If we have pending orphaned tool calls from a previous assistant, insert synthetic results now
			insertSyntheticToolResults();

			// Skip errored/aborted assistant messages entirely.
			// These are incomplete turns that shouldn't be replayed:
			// - May have partial content (reasoning without message, incomplete tool calls)
			// - Replaying them can cause API errors (e.g., OpenAI "reasoning without following item")
			// - The model should retry from the last valid state
			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				continue;
			}

			// Track tool calls from this assistant message
			const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall") as ToolCall[];
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				pendingToolCallIds = new Set(toolCalls.map((toolCall) => toolCall.id));
				existingToolResultIds = new Set();
				lateResults = collectResultsBeforeNextAssistant(transformed, index);
			}

			result.push(msg);
		} else if (msg.role === "toolResult") {
			if (movedResults.has(msg)) continue;
			if (pendingToolCallIds.has(msg.toolCallId) && !existingToolResultIds.has(msg.toolCallId)) {
				existingToolResultIds.add(msg.toolCallId);
				bufferedResults.set(msg.toolCallId, msg);
				continue;
			}
			result.push(msg);
		} else if (msg.role === "user") {
			// User message interrupts tool flow - insert synthetic results for orphaned calls
			insertSyntheticToolResults();
			result.push(msg);
		} else {
			flushBufferedResults();
			result.push(msg);
		}
	}

	// If the conversation ends with unresolved tool calls, synthesize results now.
	insertSyntheticToolResults();

	return result;
}

/** Tool results stored after the assistant message at `assistantIndex` and before the next one, first per call id. */
function collectResultsBeforeNextAssistant(
	messages: Message[],
	assistantIndex: number,
): Map<string, ToolResultMessage> {
	const results = new Map<string, ToolResultMessage>();
	for (const msg of messages.slice(assistantIndex + 1)) {
		if (msg.role === "assistant") break;
		if (msg.role === "toolResult" && !results.has(msg.toolCallId)) results.set(msg.toolCallId, msg);
	}
	return results;
}

/** A run of consecutive tool results. Providers that need one turn for all results of a tool-call batch send it as one message. */
export interface ToolResultGroup {
	role: "toolResults";
	results: ToolResultMessage[];
}

/** Merge each run of consecutive toolResult messages into one group; other messages stay as they are. */
export function groupToolResults(messages: Message[]): Array<UserMessage | AssistantMessage | ToolResultGroup> {
	const groups: Array<UserMessage | AssistantMessage | ToolResultGroup> = [];
	for (const message of messages) {
		if (message.role !== "toolResult") {
			groups.push(message);
			continue;
		}
		const previous = groups.at(-1);
		if (previous?.role === "toolResults") previous.results.push(message);
		else groups.push({ role: "toolResults", results: [message] });
	}
	return groups;
}
