import { describe, expect, it } from "vitest";
import { EventStream } from "../src/utils/event-stream.ts";

describe("EventStream failures", () => {
	it("rejects the final result", async () => {
		const stream = new EventStream<number, number>(
			() => false,
			(event) => event,
		);
		const failure = new Error("stream failed");
		const result = stream.result();

		stream.fail(failure);

		await expect(result).rejects.toBe(failure);
	});

	it("rejects an active iterator", async () => {
		const stream = new EventStream<number, number>(
			() => false,
			(event) => event,
		);
		const failure = new Error("stream failed");
		const iterator = stream[Symbol.asyncIterator]();
		const next = iterator.next();

		stream.fail(failure);

		await expect(next).rejects.toBe(failure);
	});
});

describe("EventStream buffering", () => {
	it("drains a large buffer in order and in linear time", async () => {
		const stream = new EventStream<number, number>(
			(event) => event === -1,
			(event) => event,
		);
		const count = 400_000;
		for (let i = 0; i < count; i++) stream.push(i);
		stream.push(-1);

		// Draining with Array.shift() took about 7 s for this buffer; a linear queue takes tens of milliseconds.
		const startedAt = performance.now();
		let received = 0;
		let outOfOrder = 0;
		for await (const event of stream) {
			if (event === -1) break;
			if (event !== received) outOfOrder++;
			received++;
		}
		const elapsedMs = performance.now() - startedAt;

		expect(received).toBe(count);
		expect(outOfOrder).toBe(0);
		expect(elapsedMs).toBeLessThan(2000);
	});

	it("keeps FIFO order when pushes and reads interleave", async () => {
		const stream = new EventStream<number, number>(
			(event) => event === -1,
			(event) => event,
		);
		const iterator = stream[Symbol.asyncIterator]();
		stream.push(1);
		stream.push(2);
		expect((await iterator.next()).value).toBe(1);
		stream.push(3);
		expect((await iterator.next()).value).toBe(2);
		expect((await iterator.next()).value).toBe(3);
		const pending = iterator.next();
		stream.push(4);
		expect((await pending).value).toBe(4);
	});
});
