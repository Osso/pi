import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Returns public prose without changing signed thinking blocks needed for provider replay. */
export function getAssistantContentText(content: AssistantMessage["content"][number]): string | undefined {
	if (content.type === "text") return content.text;
	if (content.type === "thinking" && isServerNarrationSignature(content.thinkingSignature)) return content.thinking;
	return undefined;
}

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
			if (offset + length > bytes.length) return undefined;
			if (key >>> 3 === field) return bytes.subarray(offset, offset + length);
			offset += length;
		} else return undefined;
	}
	return undefined;
}

/** Identifies public Anthropic narration via envelope field 2 -> 1 -> 8, as decoded by Claude Code. */
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
