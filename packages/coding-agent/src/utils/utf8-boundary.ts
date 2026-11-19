/**
 * Pass a byte stream on in chunks that end on a UTF-8 character boundary. Stdout and stderr share one output
 * decoder, so a stderr write between the bytes of one stdout character would otherwise corrupt both.
 * At most three bytes of an unfinished character are held until the next chunk or `flush()`.
 */
export function splitAtUtf8Boundaries(emit: (data: Buffer) => void): { write(data: Buffer): void; flush(): void } {
	let pending: Buffer | undefined;
	return {
		write(data) {
			const bytes = pending ? Buffer.concat([pending, data]) : data;
			const end = completeUtf8Length(bytes);
			pending = end < bytes.length ? Buffer.from(bytes.subarray(end)) : undefined;
			if (end > 0) emit(bytes.subarray(0, end));
		},
		flush() {
			if (pending) emit(pending);
			pending = undefined;
		},
	};
}

/** Length of the prefix of `bytes` that does not end inside a multi-byte UTF-8 sequence. */
function completeUtf8Length(bytes: Buffer): number {
	for (let index = bytes.length - 1; index >= Math.max(0, bytes.length - 3); index--) {
		const byte = bytes[index] ?? 0;
		if ((byte & 0xc0) === 0x80) continue;
		const sequenceLength = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		return bytes.length - index < sequenceLength ? index : bytes.length;
	}
	return bytes.length;
}
