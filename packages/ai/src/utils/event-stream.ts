import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

/** Two-stack FIFO: amortized O(1) dequeue, where Array.shift() made draining a buffered stream quadratic. */
class FifoQueue<T> {
	private incoming: T[] = [];
	private outgoing: T[] = [];

	get length(): number {
		return this.incoming.length + this.outgoing.length;
	}

	enqueue(value: T): void {
		this.incoming.push(value);
	}

	dequeue(): T | undefined {
		if (this.outgoing.length === 0) {
			this.outgoing = this.incoming.reverse();
			this.incoming = [];
		}
		return this.outgoing.pop();
	}
}

// Generic event stream class for async iteration
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue = new FifoQueue<T>();
	private waiting: Array<{
		resolve: (value: IteratorResult<T>) => void;
		reject: (error: unknown) => void;
	}> = [];
	private done = false;
	private failed = false;
	private failure: unknown;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private rejectFinalResult!: (error: unknown) => void;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise((resolve, reject) => {
			this.resolveFinalResult = resolve;
			this.rejectFinalResult = reject;
		});
		void this.finalResultPromise.catch(() => undefined);
	}

	push(event: T): void {
		if (this.done) return;

		const isComplete = this.isComplete(event);
		if (isComplete) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		// Deliver to waiting consumer or queue it
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter.resolve({ value: event, done: false });
		} else {
			this.queue.enqueue(event);
		}
		if (isComplete) this.resolveWaitingIterators();
	}

	end(result?: R): void {
		if (this.done) return;
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		this.resolveWaitingIterators();
	}

	private resolveWaitingIterators(): void {
		while (true) {
			const waiter = this.waiting.shift();
			if (!waiter) break;
			waiter.resolve({ value: undefined, done: true });
		}
	}

	fail(error: unknown): void {
		if (this.done) return;
		this.done = true;
		this.failed = true;
		this.failure = error;
		this.rejectFinalResult(error);
		while (true) {
			const waiter = this.waiting.shift();
			if (!waiter) break;
			waiter.reject(error);
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.dequeue() as T;
			} else if (this.done) {
				if (this.failed) throw this.failure;
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve, reject) =>
					this.waiting.push({ resolve, reject }),
				);
				if (result.done) return;
				yield result.value;
			}
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
