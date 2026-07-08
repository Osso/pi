import type { ToolCallEventResult } from "../extensions/types.ts";
import {
	type ApprovalMemoryRecord,
	type ApprovalRecentDecision,
	normalizeApprovalMemorySuggestion,
	summarizeToolInput,
} from "./approval-memory.ts";

export type AutoReviewerPromptInput = {
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
	cwd: string;
	escalation?: "deny" | "ask";
	recentDecisions?: ApprovalRecentDecision[];
	persistentMemory?: ApprovalMemoryRecord[];
};

export type AutoReviewerDecision =
	| {
			behavior: "allow";
			memorySuggestion?: ApprovalMemoryRecord;
	  }
	| {
			behavior: "deny" | "ask";
			message: string;
			memorySuggestion?: ApprovalMemoryRecord;
	  };

export type AutoReviewerModelCall = (prompt: string) => Promise<unknown>;

export type AutoReviewerOptions = {
	onAsk?: (reason: string) => Promise<ToolCallEventResult | undefined>;
	recordDecision?: (decision: ApprovalRecentDecision) => void;
	recordMemorySuggestion?: (memory: ApprovalMemoryRecord) => void;
};

export function buildAutoReviewerPrompt(input: AutoReviewerPromptInput): string {
	return [
		"You are reviewing whether a coding agent may execute one tool call.",
		"Approve ordinary bounded-risk coding-agent work that is related to the user's task.",
		"Be permissive for routine code edits, builds, tests, package-manager reads, local inspection, and cleanup with bounded scope.",
		"Allow temporary workspace or cache cleanup, including deleting files under /tmp.",
		input.escalation === "ask"
			? "Ask a human only for actions likely to trash the laptop, cause irreversible user-data or system damage, expose credentials, or perform unrelated external side effects."
			: "Deny only actions likely to trash the laptop, cause irreversible user-data or system damage, expose credentials, or perform unrelated external side effects.",
		"When risk is ordinary, local, reversible, or limited to temporary/cache/workspace files, approve.",
		"Respond with exactly one JSON object and no markdown.",
		"You may include an optional memorySuggestion object with toolName, pattern, decision, scope, and reason when a durable general approval rule would help future reviews.",
		input.escalation === "ask"
			? 'Allowed responses: {"behavior":"allow"} or {"behavior":"ask","message":"short reason"}.'
			: 'Allowed responses: {"behavior":"allow"} or {"behavior":"deny","message":"short reason"}.',
		...formatMemorySection("Persistent approval memory", input.persistentMemory),
		...formatRecentDecisions(input.recentDecisions),
		"",
		`Tool call id: ${input.toolCallId}`,
		`Tool name: ${input.toolName}`,
		`Working directory: ${input.cwd}`,
		"Input:",
		JSON.stringify(input.input, null, 2),
	].join("\n");
}

export function parseAutoReviewerDecision(rawResponse: unknown): AutoReviewerDecision | undefined {
	const response = parseResponseObject(rawResponse);
	if (!response) {
		return undefined;
	}

	const memorySuggestion = normalizeApprovalMemorySuggestion(response.memorySuggestion);

	if (response.behavior === "allow") {
		return memorySuggestion ? { behavior: "allow", memorySuggestion } : { behavior: "allow" };
	}

	if (
		(response.behavior === "deny" || response.behavior === "ask") &&
		typeof response.message === "string" &&
		response.message.length > 0
	) {
		return memorySuggestion
			? { behavior: response.behavior, message: response.message, memorySuggestion }
			: { behavior: response.behavior, message: response.message };
	}

	return undefined;
}

export async function reviewToolCallWithAutoReviewer(
	input: AutoReviewerPromptInput,
	callModel: AutoReviewerModelCall,
	options: AutoReviewerOptions = {},
): Promise<ToolCallEventResult | undefined> {
	const response = await callModel(buildAutoReviewerPrompt(input));
	const decision = parseAutoReviewerDecision(response);
	if (!decision) {
		return { block: true, reason: "LLM approval reviewer returned an invalid response" };
	}

	options.recordDecision?.({
		decision: decision.behavior,
		inputSummary: summarizeToolInput(input.input),
		reason: decision.behavior === "allow" ? undefined : decision.message,
		toolName: input.toolName,
	});
	if (decision.memorySuggestion) {
		options.recordMemorySuggestion?.(decision.memorySuggestion);
	}

	if (decision.behavior === "deny") {
		return input.escalation === "ask" && options.onAsk
			? options.onAsk(decision.message)
			: { block: true, reason: decision.message };
	}

	if (decision.behavior === "ask") {
		return options.onAsk ? options.onAsk(decision.message) : { block: true, reason: decision.message };
	}

	return undefined;
}

function formatMemorySection(title: string, memory: ApprovalMemoryRecord[] | undefined): string[] {
	if (!memory || memory.length === 0) {
		return [];
	}

	return ["", `${title}:`, JSON.stringify(memory, null, 2)];
}

function formatRecentDecisions(decisions: ApprovalRecentDecision[] | undefined): string[] {
	if (!decisions || decisions.length === 0) {
		return [];
	}

	return ["", "Recent session approval decisions:", JSON.stringify(decisions, null, 2)];
}

function parseResponseObject(rawResponse: unknown): Record<string, unknown> | undefined {
	if (typeof rawResponse === "string") {
		return parseJsonObject(rawResponse);
	}

	if (isRecord(rawResponse)) {
		const text = extractTextContent(rawResponse);
		if (text !== undefined) {
			return parseJsonObject(text);
		}
		return rawResponse;
	}

	return undefined;
}

function extractTextContent(response: Record<string, unknown>): string | undefined {
	const content = response.content;
	if (!Array.isArray(content)) {
		return undefined;
	}

	for (const item of content) {
		if (!isRecord(item)) {
			continue;
		}
		if (item.type === "text" && typeof item.text === "string") {
			return item.text;
		}
	}

	return undefined;
}

function parseJsonObject(json: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(json);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
