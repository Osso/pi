import type { EntryRenderer, ExtensionAPI, MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";

const SUPERVISOR_INSTRUCTION_OPEN = "<supervisor-instruction>";
const SUPERVISOR_INSTRUCTION_CLOSE = "</supervisor-instruction>";

export function supervisorInstructionContent(instructions: string): string {
	return `${SUPERVISOR_INSTRUCTION_OPEN}\n${instructions}\n${SUPERVISOR_INSTRUCTION_CLOSE}`;
}

function supervisorMessage(content: string): { customType: string; content: string; display: true } {
	return {
		customType: "supervisor",
		content: supervisorInstructionContent(content),
		display: true,
	};
}

export function sendSupervisorInstructions(pi: ExtensionAPI, instructions: string): void {
	pi.sendMessage(supervisorMessage(instructions), { deliverAs: "followUp", triggerTurn: true });
}

export function appendSupervisorStatus(pi: ExtensionAPI, message: string): void {
	pi.appendEntry("supervisor-status", { message });
}

function hasSupervisorInstructionWrapper(content: string): boolean {
	return content.startsWith(SUPERVISOR_INSTRUCTION_OPEN) && content.endsWith(SUPERVISOR_INSTRUCTION_CLOSE);
}

function supervisorInstructionBody(content: string): string {
	if (!hasSupervisorInstructionWrapper(content)) return content;
	let body = content.slice(SUPERVISOR_INSTRUCTION_OPEN.length, -SUPERVISOR_INSTRUCTION_CLOSE.length);
	if (body.startsWith("\n")) body = body.slice(1);
	if (body.endsWith("\n")) body = body.slice(0, -1);
	return body;
}

export const renderSupervisorStatusEntry: EntryRenderer = (entry, _rendererOptions, theme) => {
	const details = entry.data as { message?: unknown } | undefined;
	const message = typeof details?.message === "string" ? details.message : "Supervisor status unavailable";
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("[Supervisor]")), 0, 0));
	box.addChild(new Spacer(1));
	box.addChild(new Text(theme.fg("customMessageText", message), 0, 0));
	return box;
};

export const renderSupervisorMessage: MessageRenderer = (message, _rendererOptions, theme) => {
	const content = typeof message.content === "string" ? message.content : "";
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("[Supervisor]")), 0, 0));
	box.addChild(new Spacer(1));
	box.addChild(new Text(theme.fg("customMessageText", supervisorInstructionBody(content)), 0, 0));
	return box;
};
