import type { ResponseOutputItem, ResponseReasoningItem } from "openai/resources/responses/responses.js";
import type { AssistantMessage } from "../types.ts";

/**
 * Azure OpenAI can omit reasoning.encrypted_content from response.output_item.done and send it only in
 * response.completed.response.output. Copy it into the stored reasoning signature, so store:false multi-turn
 * replay keeps the reasoning (#6409). Signatures that already carry encrypted content are left unchanged.
 */
export function backfillReasoningSignatures(
	content: AssistantMessage["content"],
	responseOutput: readonly ResponseOutputItem[],
): void {
	const encryptedContentById = new Map<string, string>();
	for (const item of responseOutput) {
		if (item.type === "reasoning" && item.encrypted_content)
			encryptedContentById.set(item.id, item.encrypted_content);
	}
	if (encryptedContentById.size === 0) return;
	for (const block of content) {
		if (block.type !== "thinking" || !block.thinkingSignature) continue;
		const storedItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
		const encryptedContent = encryptedContentById.get(storedItem.id);
		if (!encryptedContent || storedItem.encrypted_content) continue;
		block.thinkingSignature = JSON.stringify({ ...storedItem, encrypted_content: encryptedContent });
	}
}
