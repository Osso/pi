import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("resume continuation request", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("defaults to false and consumes requests once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		expect(harness.session.consumeResumeContinuationRequest()).toBe(false);
		expect(harness.session.consumeResumeContinuationRequest()).toBe(false);
	});

	it("allows session_start extensions to request one-shot continuation", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.requestResumeContinuation();
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.bindExtensions({ mode: "print" });

		expect(harness.session.consumeResumeContinuationRequest()).toBe(true);
		expect(harness.session.consumeResumeContinuationRequest()).toBe(false);
	});
});
