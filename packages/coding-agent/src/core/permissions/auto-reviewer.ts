import type { ToolCallEventResult } from "../extensions/types.ts";

export type AutoReviewerPromptInput = {
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
	cwd: string;
};

export type AutoReviewerDecision =
	| {
			behavior: "allow";
	  }
	| {
			behavior: "deny";
			message: string;
	  };

export type AutoReviewerModelCall = (prompt: string) => Promise<unknown>;

export function buildAutoReviewerPrompt(input: AutoReviewerPromptInput): string {
	return [
		"You are reviewing whether a coding agent may execute one tool call.",
		"Approve ordinary bounded-risk coding-agent work that is related to the user's task.",
		"Be permissive for routine code edits, builds, tests, package-manager reads, local inspection, and cleanup with bounded scope.",
		"Allow temporary workspace or cache cleanup, including deleting files under /tmp.",
		"Deny only actions likely to trash the laptop, cause irreversible user-data or system damage, expose credentials, or perform unrelated external side effects.",
		"When risk is ordinary, local, reversible, or limited to temporary/cache/workspace files, approve.",
		"Respond with exactly one JSON object and no markdown.",
		'Allowed responses: {"behavior":"allow"} or {"behavior":"deny","message":"short reason"}.',
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

	if (response.behavior === "allow") {
		return { behavior: "allow" };
	}

	if (response.behavior === "deny" && typeof response.message === "string" && response.message.length > 0) {
		return { behavior: "deny", message: response.message };
	}

	return undefined;
}

export async function reviewToolCallWithAutoReviewer(
	input: AutoReviewerPromptInput,
	callModel: AutoReviewerModelCall,
): Promise<ToolCallEventResult | undefined> {
	const response = await callModel(buildAutoReviewerPrompt(input));
	const decision = parseAutoReviewerDecision(response);
	if (!decision) {
		return { block: true, reason: "LLM approval reviewer returned an invalid response" };
	}

	if (decision.behavior === "deny") {
		return { block: true, reason: decision.message };
	}

	return undefined;
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
