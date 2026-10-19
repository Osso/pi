import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Component, Container, ProcessTerminal, Spacer, TUI } from "@earendil-works/pi-tui";
import { AssistantMessageComponent } from "../modes/interactive/components/assistant-message.ts";
import { BashExecutionComponent } from "../modes/interactive/components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "../modes/interactive/components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../modes/interactive/components/compaction-summary-message.ts";
import { CustomMessageComponent } from "../modes/interactive/components/custom-message.ts";
import { SkillInvocationMessageComponent } from "../modes/interactive/components/skill-invocation-message.ts";
import { ToolExecutionComponent } from "../modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../modes/interactive/components/user-message.ts";
import { stripAnsi } from "../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import { loadSessionContextEntries, sessionEntryToContextMessages } from "./session-manager.ts";
import { parseSkillBlock } from "./skill-block.ts";
import type { TruncationResult } from "./tools/truncate.ts";

/** Components require a TUI for invalidation, but exporting never starts or redraws a terminal. */
class ExportUI extends TUI {
	override requestRender(): void {}
}

function sanitizeSavedText(value: string): string {
	return sanitizeBinaryOutput(stripAnsi(value))
		.replace(/\r\n?/g, "\n")
		.replace(/[\u007f-\u009f]/g, "");
}

function sanitizeMessage(message: AgentMessage): AgentMessage {
	return JSON.parse(
		JSON.stringify(message, (_key, value) => (typeof value === "string" ? sanitizeSavedText(value) : value)),
	);
}

/** Preserve renderer styles only: no shell integration, image, clipboard, or cursor protocols. */
function renderLine(line: string): string {
	const rendered = line
		.split(/(\x1b\[[0-9;:]*m)/g)
		.map((part) => (/^\x1b\[[0-9;:]*m$/.test(part) ? part : sanitizeSavedText(part)))
		.join("");
	return `${rendered}\x1b[0m`;
}

function addUserMessage(chat: Container, message: Extract<AgentMessage, { role: "user" }>): void {
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("");
	if (!text) return;
	if (chat.children.length) chat.addChild(new Spacer(1));
	const skill = parseSkillBlock(text);
	if (!skill) {
		chat.addChild(new UserMessageComponent(text));
		return;
	}
	chat.addChild(new SkillInvocationMessageComponent(skill));
	if (skill.userMessage) {
		chat.addChild(new Spacer(1));
		chat.addChild(new UserMessageComponent(skill.userMessage));
	}
}

function renderBashMessage(message: Extract<AgentMessage, { role: "bashExecution" }>, ui: TUI): Component {
	const component = new BashExecutionComponent(message.command, ui, message.excludeFromContext, {
		showElapsed: false,
	});
	component.appendOutput(message.output);
	component.setComplete(
		message.exitCode,
		message.cancelled,
		message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
		message.fullOutputPath,
	);
	return component;
}

function addAssistantMessage(
	chat: Container,
	message: Extract<AgentMessage, { role: "assistant" }>,
	pending: Map<string, ToolExecutionComponent>,
	ui: TUI,
	cwd: string,
): void {
	chat.addChild(new AssistantMessageComponent(message));
	for (const content of message.content) {
		if (content.type !== "toolCall") continue;
		const component = new ToolExecutionComponent(
			content.name,
			content.id,
			content.arguments,
			{ showImages: false },
			undefined,
			ui,
			cwd,
		);
		chat.addChild(component);
		if (message.stopReason === "aborted" || message.stopReason === "error") {
			component.updateResult(
				{
					content: [
						{
							type: "text",
							text: message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error"),
						},
					],
					isError: true,
				},
				false,
				message.timestamp,
			);
		} else {
			pending.set(content.id, component);
		}
	}
}

function addMessage(
	chat: Container,
	message: AgentMessage,
	pending: Map<string, ToolExecutionComponent>,
	ui: TUI,
	cwd: string,
): void {
	switch (message.role) {
		case "user":
			addUserMessage(chat, message);
			break;
		case "assistant":
			addAssistantMessage(chat, message, pending, ui, cwd);
			break;
		case "toolResult": {
			pending.get(message.toolCallId)?.updateResult(message, false, message.timestamp);
			pending.delete(message.toolCallId);
			break;
		}
		case "custom":
			if (message.display) chat.addChild(new CustomMessageComponent(message));
			break;
		case "compactionSummary":
			chat.addChild(new Spacer(1));
			chat.addChild(new CompactionSummaryMessageComponent(message));
			break;
		case "branchSummary":
			chat.addChild(new Spacer(1));
			chat.addChild(new BranchSummaryMessageComponent(message));
			break;
		case "bashExecution":
			chat.addChild(renderBashMessage(message, ui));
			break;
	}
}

/**
 * Render current loaded history, matching the normal compaction-aware session view.
 * Caller initializes the theme/capabilities. No agent, extensions, settings, or terminal is started.
 * Tools and summaries retain their normal collapsed presentation; images are disabled.
 * Returns LF-terminated ANSI text. A local terminal writer must translate LF to CRLF when needed.
 */
export function exportSessionToTerminal(sessionPath: string, columns: number): string {
	if (!Number.isSafeInteger(columns) || columns <= 0)
		throw new Error("Terminal columns must be a positive safe integer");
	const { header, entries } = loadSessionContextEntries(sessionPath);
	const chat = new Container();
	const pending = new Map<string, ToolExecutionComponent>();
	const ui = new ExportUI(new ProcessTerminal());
	for (const entry of entries) {
		for (const message of sessionEntryToContextMessages(entry)) {
			addMessage(chat, sanitizeMessage(message), pending, ui, header.cwd);
		}
	}
	return `${chat.render(columns).map(renderLine).join("\n")}\n`;
}
