import type { ToolCallEvent, ToolCallEventResult } from "../extensions/types.ts";

export type PermissionPromptInput = {
	tool_name: string;
	input: Record<string, unknown>;
	tool_use_id: string;
	cwd: string;
};

export type PermissionPromptCaller = (permissionPromptTool: string, input: PermissionPromptInput) => Promise<unknown>;

export type PermissionPromptDecision =
	| {
			behavior: "allow";
			updatedInput?: Record<string, unknown>;
	  }
	| {
			behavior: "deny";
			message: string;
	  };

export type PermissionPromptHandlerOptions = {
	permissionPromptTool: string | undefined;
	cwd: string;
	callTool: PermissionPromptCaller;
};

const MCP_TOOL_NAME_PATTERN = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;

export function parsePermissionPromptDecision(rawResponse: unknown): PermissionPromptDecision | undefined {
	const response = parseResponseObject(rawResponse);
	if (!response) {
		return undefined;
	}

	const behavior = response.behavior;
	if (behavior === "allow") {
		const updatedInput = response.updatedInput;
		if (updatedInput === undefined) {
			return { behavior };
		}
		if (!isRecord(updatedInput)) {
			return undefined;
		}
		return { behavior, updatedInput };
	}

	if (behavior === "deny") {
		const message = response.message;
		if (typeof message !== "string" || message.length === 0) {
			return undefined;
		}
		return { behavior, message };
	}

	return undefined;
}

export function createPermissionPromptHandler(
	options: PermissionPromptHandlerOptions,
): (event: ToolCallEvent) => Promise<ToolCallEventResult | undefined> {
	return async (event) => {
		const { permissionPromptTool } = options;
		if (!permissionPromptTool || !MCP_TOOL_NAME_PATTERN.test(permissionPromptTool)) {
			return undefined;
		}

		let decision: PermissionPromptDecision | undefined;
		try {
			const response = await options.callTool(permissionPromptTool, {
				cwd: options.cwd,
				input: structuredClone(event.input) as Record<string, unknown>,
				tool_name: event.toolName,
				tool_use_id: event.toolCallId,
			});
			decision = parsePermissionPromptDecision(response);
		} catch {
			return undefined;
		}

		if (!decision) {
			return undefined;
		}

		if (decision.behavior === "deny") {
			return { block: true, reason: decision.message };
		}

		if (decision.updatedInput) {
			replaceInputInPlace(event.input, decision.updatedInput);
		}

		return undefined;
	};
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

function replaceInputInPlace(target: Record<string, unknown>, source: Record<string, unknown>): void {
	for (const key of Object.keys(target)) {
		delete target[key];
	}
	Object.assign(target, source);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
