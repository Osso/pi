import { type AssistantMessage, isServerNarrationSignature } from "@earendil-works/pi-ai";

/** Returns public prose without changing signed thinking blocks needed for provider replay. */
export function getAssistantContentText(content: AssistantMessage["content"][number]): string | undefined {
	if (content.type === "text") return content.text;
	if (content.type === "thinking" && isServerNarrationSignature(content.thinkingSignature)) return content.thinking;
	return undefined;
}
