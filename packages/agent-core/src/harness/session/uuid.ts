let lastTimestamp = -Infinity;
let sequence = 0;

function fillRandomBytes(bytes: Uint8Array): void {
	const crypto = globalThis.crypto;
	if (crypto?.getRandomValues) {
		crypto.getRandomValues(bytes);
		return;
	}
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = Math.floor(Math.random() * 256);
	}
}

export function uuidv7(): string {
	const random = new Uint8Array(16);
	fillRandomBytes(random);
	const timestamp = Date.now();

	if (timestamp > lastTimestamp) {
		const [, , , , , , random6, random7, random8, random9] = random;
		if (random6 === undefined || random7 === undefined || random8 === undefined || random9 === undefined) {
			throw new Error("Random byte buffer is incomplete");
		}
		sequence = random6 * 0x1000000 + random7 * 0x10000 + random8 * 0x100 + random9;
		lastTimestamp = timestamp;
	} else {
		sequence = (sequence + 1) >>> 0;
		if (sequence === 0) {
			lastTimestamp++;
		}
	}

	const bytes = new Uint8Array(16);
	bytes[0] = (lastTimestamp / 0x10000000000) & 0xff;
	bytes[1] = (lastTimestamp / 0x100000000) & 0xff;
	bytes[2] = (lastTimestamp / 0x1000000) & 0xff;
	bytes[3] = (lastTimestamp / 0x10000) & 0xff;
	bytes[4] = (lastTimestamp / 0x100) & 0xff;
	bytes[5] = lastTimestamp & 0xff;
	bytes[6] = 0x70 | ((sequence >>> 28) & 0x0f);
	bytes[7] = (sequence >>> 20) & 0xff;
	bytes[8] = 0x80 | ((sequence >>> 14) & 0x3f);
	bytes[9] = (sequence >>> 6) & 0xff;
	const [, , , , , , , , , , random10, random11, random12, random13, random14, random15] = random;
	if (
		random10 === undefined ||
		random11 === undefined ||
		random12 === undefined ||
		random13 === undefined ||
		random14 === undefined ||
		random15 === undefined
	) {
		throw new Error("Random byte buffer is incomplete");
	}
	bytes[10] = ((sequence & 0x3f) << 2) | (random10 & 0x03);
	bytes[11] = random11;
	bytes[12] = random12;
	bytes[13] = random13;
	bytes[14] = random14;
	bytes[15] = random15;

	return formatUuid(bytes);
}

function formatUuid(bytes: Uint8Array): string {
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
