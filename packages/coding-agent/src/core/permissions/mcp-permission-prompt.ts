import {
	type DesktopNotificationHandle,
	type DesktopNotifier,
	PERSISTENT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS,
	toDesktopNotificationHandle,
} from "../desktop-notification.ts";
import type { ToolCallEvent, ToolCallEventResult } from "../extensions/types.ts";
import { buildPermissionRuleContent, type PermissionRuleStore, type PermissionRuleUpdate } from "./rule-store.ts";

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
			updatedPermissions?: PermissionRuleUpdate[];
	  }
	| {
			behavior: "deny";
			message: string;
	  };

export type PermissionPromptHandlerOptions = {
	permissionPromptTool: string | undefined;
	cwd: string;
	callTool: PermissionPromptCaller;
	desktopNotifier?: DesktopNotifier;
	ruleStore?: PermissionRuleStore;
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
		const updatedPermissions = parseUpdatedPermissions(response.updatedPermissions);
		if (response.updatedPermissions !== undefined && updatedPermissions === undefined) {
			return undefined;
		}
		if (updatedInput === undefined) {
			return updatedPermissions === undefined ? { behavior } : { behavior, updatedPermissions };
		}
		if (!isRecord(updatedInput)) {
			return undefined;
		}
		return updatedPermissions === undefined
			? { behavior, updatedInput }
			: { behavior, updatedInput, updatedPermissions };
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

		const ruleContent = buildPermissionRuleContent(event.toolName, event.input);
		if (options.ruleStore?.hasAllowRule(event.toolName, ruleContent)) {
			return undefined;
		}

		const notificationHandle = notifyPermissionPrompt(event, options.cwd, options.desktopNotifier);

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
		} finally {
			closePermissionPromptNotification(notificationHandle);
		}

		if (!decision) {
			return undefined;
		}

		if (decision.behavior === "deny") {
			return { block: true, reason: decision.message };
		}

		options.ruleStore?.applyUpdatedPermissions(event.toolName, decision.updatedPermissions);
		if (decision.updatedInput) {
			replaceInputInPlace(event.input, decision.updatedInput);
		}

		return undefined;
	};
}

function notifyPermissionPrompt(
	event: ToolCallEvent,
	cwd: string,
	desktopNotifier: DesktopNotifier | undefined,
): DesktopNotificationHandle | undefined {
	if (!desktopNotifier) {
		return undefined;
	}
	try {
		return toDesktopNotificationHandle(
			desktopNotifier({
				body: `Permission approval needed for ${event.toolName} in ${cwd}.`,
				expireTimeMs: PERSISTENT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS,
				title: "Pi permission approval needed",
			}),
		);
	} catch (error) {
		console.error("Failed to send permission prompt desktop notification:", error);
		return undefined;
	}
}

function closePermissionPromptNotification(notificationHandle: DesktopNotificationHandle | undefined): void {
	if (!notificationHandle) {
		return;
	}
	try {
		notificationHandle.close();
	} catch (error) {
		console.error("Failed to close permission prompt desktop notification:", error);
	}
}

function parseUpdatedPermissions(value: unknown): PermissionRuleUpdate[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		return undefined;
	}

	const updates: PermissionRuleUpdate[] = [];
	for (const update of value) {
		if (!isRecord(update)) {
			return undefined;
		}
		if (
			update.type !== "addRules" ||
			update.behavior !== "allow" ||
			!isPermissionRuleDestination(update.destination) ||
			!Array.isArray(update.rules)
		) {
			return undefined;
		}

		const rules = update.rules.filter((rule): rule is string => typeof rule === "string");
		if (rules.length !== update.rules.length) {
			return undefined;
		}

		updates.push({
			type: "addRules",
			destination: update.destination,
			behavior: "allow",
			rules,
		});
	}

	return updates;
}

function isPermissionRuleDestination(value: unknown): value is PermissionRuleUpdate["destination"] {
	return value === "session" || value === "userSettings" || value === "projectSettings" || value === "localSettings";
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
