import { describe, expect, it } from "vitest";
import { EventStream } from "../src/utils/event-stream.ts";

describe("EventStream failures", () => {
	it("rejects the final result", async () => {
		const stream = new EventStream<number, number>(() => false, (event) => event);
		const failure = new Error("stream failed");
		const result = stream.result();

		stream.fail(failure);

		await expect(result).rejects.toBe(failure);
	});

	it("rejects an active iterator", async () => {
		const stream = new EventStream<number, number>(() => false, (event) => event);
		const failure = new Error("stream failed");
		const iterator = stream[Symbol.asyncIterator]();
		const next = iterator.next();
		void stream.result().catch(() => undefined);

		stream.fail(failure);

		await expect(next).rejects.toBe(failure);
	});
});
