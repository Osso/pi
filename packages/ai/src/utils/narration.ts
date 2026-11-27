/**
 * Signed Anthropic narration: public reply prose that the API returns inside a thinking block.
 * The block kind sits at protobuf envelope field 2 -> 1 -> 8 of the signature, as Claude Code decodes it.
 */

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function readProtobufVarint(bytes: Uint8Array, offset: number): { value: number; end: number } {
	let value = 0;
	for (let shift = 0; offset < bytes.length && shift < 35; shift += 7) {
		const byte = bytes[offset++];
		if (byte === undefined) throw new Error("truncated varint");
		value += (byte & 0x7f) * 2 ** shift;
		if (byte < 0x80) return { value, end: offset };
	}
	throw new Error("truncated varint");
}

/** Returns the bytes of the first length-delimited protobuf field `field`, if any. */
function readProtobufField(bytes: Uint8Array, field: number): Uint8Array | undefined {
	let offset = 0;
	while (offset < bytes.length) {
		const key = readProtobufVarint(bytes, offset);
		offset = key.end;
		const wireType = key.value & 7;
		if (wireType === 0) offset = readProtobufVarint(bytes, offset).end;
		else if (wireType === 1) offset += 8;
		else if (wireType === 5) offset += 4;
		else if (wireType === 2) {
			const length = readProtobufVarint(bytes, offset);
			const end = length.end + length.value;
			if (end > bytes.length) return undefined;
			if (key.value >>> 3 === field) return bytes.subarray(length.end, end);
			offset = end;
		} else return undefined;
	}
	return undefined;
}

/** Identifies public Anthropic narration via envelope field 2 -> 1 -> 8, as decoded by Claude Code. */
export function isServerNarrationSignature(signature: string | undefined): boolean {
	if (!signature) return false;
	try {
		const envelope = readProtobufField(decodeBase64(signature), 2);
		const header = envelope && readProtobufField(envelope, 1);
		const kind = header && readProtobufField(header, 8);
		return kind !== undefined && new TextDecoder().decode(kind) === "narration";
	} catch {
		return false;
	}
}
