import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_BYTES, truncateHead, truncateTail } from "../src/core/tools/truncate.ts";

describe("truncation at the byte limit with a final newline", () => {
	// Ten lines plus nine separators fill the limit exactly; the final newline is one byte over.
	const lines = Array.from({ length: 10 }, (_, i) => `${i}`.padEnd(i === 0 ? 1024 : 1023, "x"));
	const content = `${lines.join("\n")}\n`;

	it("does not report truncation when every line fits", () => {
		expect(Buffer.byteLength(content)).toBe(DEFAULT_MAX_BYTES + 1);
		for (const result of [truncateHead(content), truncateTail(content)]) {
			expect(result).toMatchObject({
				content,
				truncated: false,
				truncatedBy: null,
				outputLines: 10,
				totalLines: 10,
			});
		}
	});
});
