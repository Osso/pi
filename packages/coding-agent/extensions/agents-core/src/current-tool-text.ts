import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";

function selectOutputText(content: AssistantMessage["content"], textIndex?: number): string {
	const blocks = content.filter((part) => part.type === "text");
	if (blocks.length === 0) {
		throw new Error("Mailbox body requires output_text in the assistant response containing this tool call.");
	}
	if (textIndex === undefined && blocks.length !== 1) {
		throw new Error("Multiple output_text blocks: specify textIndex among the current response's text blocks.");
	}
	const selected = blocks[textIndex ?? 0];
	if (!selected) {
		throw new Error(`textIndex ${textIndex} does not identify a current output_text block.`);
	}
	if (!selected.text.trim()) {
		throw new Error(
			"Selected output_text is empty; write the mailbox body as assistant text before calling this tool.",
		);
	}
	return selected.text;
}

export function readCurrentToolCallText(
	ctx: Pick<ExtensionContext, "sessionManager">,
	toolCallId: string,
	expectedToolName: "send_agent_message" | "contact_parent",
	textIndex?: number,
): string {
	const matches = ctx.sessionManager.getBranch().flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "assistant") return [];
		const ownsCall = entry.message.content.some(
			(part) => part.type === "toolCall" && part.id === toolCallId && part.name === expectedToolName,
		);
		return ownsCall ? [entry.message] : [];
	});
	const [assistant] = matches;
	if (!assistant || matches.length !== 1) {
		throw new Error(
			`Expected one assistant response for mailbox tool ${expectedToolName} with call ID ${toolCallId}; found ${matches.length}.`,
		);
	}
	return selectOutputText(assistant.content, textIndex);
}
