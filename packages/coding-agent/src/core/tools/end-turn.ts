import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";

const endTurnSchema = Type.Object({
	reason: Type.String({ description: "Required non-empty reason for ending the current turn." }),
});

export type EndTurnToolInput = Static<typeof endTurnSchema>;

export interface EndTurnToolDetails {
	reason: string;
}

export const SUMMARIZED_REPLY_ERROR =
	"Your reply in this response was replaced by a server summary and was not shown to the user. Write the full reply again as assistant text in a response without tool calls, then call end_turn.";

/** Returns the bytes of the first length-delimited protobuf field `field`, if any. */
function readProtobufField(bytes: Uint8Array, field: number): Uint8Array | undefined {
	let offset = 0;
	const readVarint = (): number => {
		let value = 0;
		for (let shift = 0; offset < bytes.length && shift < 35; shift += 7) {
			const byte = bytes[offset++];
			value += (byte & 0x7f) * 2 ** shift;
			if (byte < 0x80) return value;
		}
		throw new Error("truncated varint");
	};
	while (offset < bytes.length) {
		const key = readVarint();
		const wireType = key & 7;
		if (wireType === 0) readVarint();
		else if (wireType === 1) offset += 8;
		else if (wireType === 5) offset += 4;
		else if (wireType === 2) {
			const length = readVarint();
			if (key >>> 3 === field) return bytes.subarray(offset, offset + length);
			offset += length;
		} else return undefined;
	}
	return undefined;
}

/**
 * Anthropic replaces prose written alongside a tool call with a server summary, delivered as a
 * thinking block whose signature tags block_kind "narration" (envelope field 2 -> 1 -> 8, the path
 * Claude Code decodes). The original text never reaches the client.
 */
export function isServerNarrationSignature(signature: string | undefined): boolean {
	if (!signature) return false;
	try {
		const envelope = readProtobufField(Buffer.from(signature, "base64"), 2);
		const header = envelope && readProtobufField(envelope, 1);
		const kind = header && readProtobufField(header, 8);
		return kind !== undefined && Buffer.from(kind).toString("utf8") === "narration";
	} catch {
		return false;
	}
}

function lostReplyToSummary(message: AssistantMessage): boolean {
	const hasText = message.content.some((part) => part.type === "text" && part.text.trim() !== "");
	return (
		!hasText &&
		message.content.some((part) => part.type === "thinking" && isServerNarrationSignature(part.thinkingSignature))
	);
}

function findCallingResponse(ctx: ExtensionContext, toolCallId: string): AssistantMessage | undefined {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (entry.message.content.some((part) => part.type === "toolCall" && part.id === toolCallId)) {
			return entry.message;
		}
	}
	return undefined;
}

export function createEndTurnToolDefinition(): ToolDefinition<typeof endTurnSchema, EndTurnToolDetails> {
	return {
		name: "end_turn",
		label: "end_turn",
		description: "End the current model turn. Provide a concise reason explaining why the turn is finished.",
		promptSnippet: "End the current model turn with a required reason",
		promptGuidelines: [
			"Call end_turn only when the task is complete, progress requires user input, or the user explicitly asks you to stop. If work remains and progress is possible, continue working instead of calling end_turn. Assistant text alone does not finish the turn.",
			"Provide one concise, non-empty reason.",
			"Thinking is never shown to the user. When responding to the user, write the reply as assistant text before calling end_turn; never leave an answer only in thinking.",
		],
		parameters: endTurnSchema,
		executionMode: "sequential",
		execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
			if (params.reason.trim() === "") {
				throw new Error("end_turn reason must be a non-empty string");
			}
			const response = ctx ? findCallingResponse(ctx, toolCallId) : undefined;
			if (response && lostReplyToSummary(response)) {
				throw new Error(SUMMARIZED_REPLY_ERROR);
			}
			return {
				content: [{ type: "text", text: `Turn ended: ${params.reason}` }],
				details: { reason: params.reason },
				terminate: true,
			};
		},
	};
}
