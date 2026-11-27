/**
 * Shared utilities for compaction and branch summarization.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { getAssistantContentText } from "../assistant-narration.ts";
import { sliceHead } from "../tools/truncate.ts";

// ============================================================================
// File Operation Tracking
// ============================================================================

/** Paths in least-to-most-recent use order. `modified` holds paths changed by `write` or `edit`. */
export interface FileOperations {
	read: Set<string>;
	modified: Set<string>;
}

export function createFileOps(): FileOperations {
	return { read: new Set(), modified: new Set() };
}

/**
 * Extract file operations from tool calls in an assistant message.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		switch (block.name) {
			case "read":
				touchPath(fileOps.read, path);
				break;
			case "write":
			case "edit":
				touchPath(fileOps.modified, path);
				break;
		}
	}
}

/** Re-adding moves the path to the end, so each set stays in least-to-most-recent use order. */
function touchPath(files: Set<string>, path: string): void {
	files.delete(path);
	files.add(path);
}

/** Add the file lists stored in the details of a pi-generated compaction or branch summary entry. */
export function addSummaryFileOps(entry: { fromHook?: boolean; details?: unknown }, fileOps: FileOperations): void {
	if (entry.fromHook || typeof entry.details !== "object" || entry.details === null) return;
	const { readFiles, modifiedFiles } = entry.details as { readFiles?: unknown; modifiedFiles?: unknown };
	if (Array.isArray(readFiles)) for (const file of readFiles) touchPath(fileOps.read, String(file));
	if (Array.isArray(modifiedFiles)) for (const file of modifiedFiles) touchPath(fileOps.modified, String(file));
}

/** Most recently used paths kept per file list; each summary carries the previous one's lists forward. */
export const MAX_SUMMARY_FILE_LIST_ENTRIES = 100;

/**
 * Compute final file lists from file operations: readFiles (files only read, not modified) and modifiedFiles.
 * Each list keeps the most recently used paths, oldest first. Without a cap the lists grow with every
 * compaction: a long session carried 6,800 paths (about 155k tokens) in each summary.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const readOnly = [...fileOps.read].filter((f) => !fileOps.modified.has(f));
	return {
		readFiles: readOnly.slice(-MAX_SUMMARY_FILE_LIST_ENTRIES),
		modifiedFiles: [...fileOps.modified].slice(-MAX_SUMMARY_FILE_LIST_ENTRIES),
	};
}

/** Remove the file lists appended by formatFileOperations, so a carried-forward summary ends up with one current block. */
export function stripFileOperations(summary: string): string {
	let stripped = summary;
	// Only the trailing blocks are the footer; the summary body may quote the same tags.
	for (const tag of ["modified-files", "read-files"]) {
		if (!stripped.endsWith(`\n</${tag}>`)) continue;
		const start = stripped.lastIndexOf(`\n\n<${tag}>\n`);
		if (start !== -1) stripped = stripped.slice(0, start);
	}
	return stripped;
}

/**
 * Format file operations as XML tags for summary.
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// Message Serialization
// ============================================================================

/** Maximum characters for a tool call argument value in serialized summaries. */
const TOOL_CALL_ARGUMENT_MAX_CHARS = 1000;

/** Maximum characters for a tool result in serialized summaries. */
const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * Truncate text to a maximum character length for summarization.
 * Keeps the beginning and appends a truncation marker.
 */
function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncatedChars = text.length - maxChars;
	return `${sliceHead(text, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function extractFullOutputPath(details: unknown): string | undefined {
	if (!isRecord(details)) return undefined;
	return typeof details.fullOutputPath === "string" && details.fullOutputPath.length > 0
		? details.fullOutputPath
		: undefined;
}

function hasToolOutputTruncation(details: unknown): boolean {
	if (!isRecord(details) || !isRecord(details.truncation)) return false;
	return details.truncation.truncated === true;
}

function serializeToolResultForSummary(content: string, details: unknown): string {
	const serialized = truncateForSummary(content, TOOL_RESULT_MAX_CHARS);
	const fullOutputPath = extractFullOutputPath(details);
	if (!fullOutputPath) return serialized;
	if (serialized.includes(fullOutputPath)) return serialized;
	if (content.length <= TOOL_RESULT_MAX_CHARS && !hasToolOutputTruncation(details)) return serialized;
	return `${serialized}\n\n[Output truncated. Full output: ${fullOutputPath}]`;
}

function serializeToolCallArgument(value: unknown): string {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) return "undefined";
	return truncateForSummary(serialized, TOOL_CALL_ARGUMENT_MAX_CHARS);
}

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 *
 * Tool call arguments and tool results are truncated to keep the summarization
 * request within reasonable token budgets. Full content is not needed for summarization.
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				const publicText = getAssistantContentText(block);
				if (publicText !== undefined) {
					textParts.push(publicText);
				} else if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${serializeToolCallArgument(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			if (textParts.length > 0) {
				parts.push(`[Assistant]: ${textParts.join("\n")}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			const content = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			if (content) {
				parts.push(`[Tool result]: ${serializeToolResultForSummary(content, msg.details)}`);
			}
		}
	}

	return parts.join("\n\n");
}

/** Why a summarization response cannot be persisted; a length stop holds partial text. */
export function summarizationFailureReason(response: AssistantMessage): string {
	if (response.stopReason === "length") return "generation hit the token cap and the summary is incomplete";
	return response.errorMessage || "Unknown error";
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
