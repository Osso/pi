import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("model request extension events", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("wraps assistant message events with model request lifecycle events", async () => {
		const events: string[] = [];
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("model_request_start", () => {
						events.push("model_request_start");
					});
					pi.on("message_start", (event) => {
						if (event.message.role === "assistant") events.push("message_start:assistant");
					});
					pi.on("message_update", (event) => {
						if (event.message.role === "assistant") events.push("message_update:assistant");
					});
					pi.on("message_end", (event) => {
						if (event.message.role === "assistant") events.push("message_end:assistant");
					});
					pi.on("model_request_end", () => {
						events.push("model_request_end");
					});
				},
			],
		});
		harness.session.setActiveToolsByName([]);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("hi");

		expect(events[0]).toBe("model_request_start");
		expect(events.at(-1)).toBe("model_request_end");
		expect(events.slice(1, -1)[0]).toBe("message_start:assistant");
		expect(events.slice(1, -1).at(-1)).toBe("message_end:assistant");
		expect(events.slice(1, -1)).toContain("message_update:assistant");
	});
});
