import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "./harness/utils/truncate.ts";
import type { AgentToolResult } from "./types.ts";

/**
 * Hard cap on tool result text. Tools truncate their output to DEFAULT_MAX_BYTES / DEFAULT_MAX_LINES and then append
 * a short continuation notice; the headroom lets that notice through, so this cap only cuts output no tool truncated.
 */
const MAX_TOOL_RESULT_TEXT_BYTES = DEFAULT_MAX_BYTES + 1024;
const MAX_TOOL_RESULT_TEXT_LINES = DEFAULT_MAX_LINES + 10;
/**
 * Cap on serialized tool result details. Details are not part of the tool result content the model receives; renderers
 * and SDK consumers read them (for example the edit diff), so the cap bounds storage and is sized like the session
 * tool-output cap. Compaction only copies small fields such as `fullOutputPath` into its prompt.
 */
const MAX_TOOL_RESULT_DETAILS_BYTES = 1024 * 1024;

export function capToolResult(result: AgentToolResult<unknown>): AgentToolResult<unknown> {
	const content = capToolResultContent(result.content);
	const details = capToolResultDetails(result.details);
	if (content === result.content && details === result.details) {
		return result;
	}
	return { ...result, content, details };
}

function capToolResultContent(content: AgentToolResult<unknown>["content"]): AgentToolResult<unknown>["content"] {
	let changed = false;
	const capped = content.map((part) => {
		if (part.type !== "text") return part;
		const cappedText = capToolResultText(part.text);
		if (cappedText === part.text) return part;
		changed = true;
		return { ...part, text: cappedText };
	});
	return changed ? capped : content;
}

function capToolResultDetails(details: unknown): unknown {
	const text = stringifyToolResultDetails(details);
	if (text === undefined || Buffer.byteLength(text, "utf-8") <= MAX_TOOL_RESULT_DETAILS_BYTES) {
		return details;
	}
	return {
		truncated: true,
		reason: "tool result details exceeded storage cap",
		maxBytes: MAX_TOOL_RESULT_DETAILS_BYTES,
		preview: capToolResultText(text),
	};
}

function stringifyToolResultDetails(details: unknown): string | undefined {
	try {
		return JSON.stringify(details);
	} catch (error) {
		return `Unserializable tool result details: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function capToolResultText(text: string): string {
	if (!isToolResultTextTooLarge(text)) return text;
	const lines = text.split("\n");
	const lineCapped =
		lines.length > MAX_TOOL_RESULT_TEXT_LINES ? lines.slice(-MAX_TOOL_RESULT_TEXT_LINES).join("\n") : text;
	let byteCapped = lineCapped;
	while (Buffer.byteLength(byteCapped, "utf-8") > MAX_TOOL_RESULT_TEXT_BYTES) {
		byteCapped = byteCapped.slice(Math.max(1, Math.floor(byteCapped.length / 10)));
	}
	return `[tool output truncated: max ${MAX_TOOL_RESULT_TEXT_BYTES} bytes / ${MAX_TOOL_RESULT_TEXT_LINES} lines]\n${byteCapped}`;
}

/** Whether text exceeds the hard tool result cap and would be cut by the agent loop. */
export function isToolResultTextTooLarge(text: string): boolean {
	return (
		text.split("\n").length > MAX_TOOL_RESULT_TEXT_LINES ||
		Buffer.byteLength(text, "utf-8") > MAX_TOOL_RESULT_TEXT_BYTES
	);
}
