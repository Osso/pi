import type { AssistantMessage } from "../types.ts";

/**
 * The agent runs every tool call in the final message. A call whose output_item.done never arrived keeps its
 * scratch buffer and may carry cut-off or mixed-up arguments (#9974), so it is never handed over. When the output
 * limit cut it off (`stopReason: "length"`) it is dropped, so the agent can compact and resume; otherwise the
 * stream fails.
 */
export function settleUnfinishedToolCalls(output: AssistantMessage): void {
	const isUnfinished = (block: AssistantMessage["content"][number]) =>
		block.type === "toolCall" && "partialJson" in block;
	if (output.stopReason === "length") output.content = output.content.filter((block) => !isUnfinished(block));
	const unfinished = output.content.find(isUnfinished);
	if (unfinished?.type === "toolCall") {
		throw new Error(
			`OpenAI Responses stream completed with an unfinished tool call: ${unfinished.name} (${unfinished.id})`,
		);
	}
}
