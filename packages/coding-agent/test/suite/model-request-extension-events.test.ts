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

	it("emits the end event for failed model requests", async () => {
		const events: string[] = [];
		harness = await createHarness({
			settings: { retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("model_request_start", () => {
						events.push("model_request_start");
					});
					pi.on("model_request_end", () => {
						events.push("model_request_end");
					});
				},
			],
		});
		harness.session.setActiveToolsByName([]);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" })]);

		await harness.session.prompt("hi");

		expect(events).toEqual(["model_request_start", "model_request_end"]);
	});

	it("emits the end event for aborted model requests", async () => {
		const events: string[] = [];
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("model_request_start", () => {
						events.push("model_request_start");
					});
					pi.on("model_request_end", () => {
						events.push("model_request_end");
					});
				},
			],
		});
		harness.session.setActiveToolsByName([]);
		harness.setResponses([fauxAssistantMessage("x".repeat(20_000))]);
		const session = harness.session;
		const sawMessageUpdate = new Promise<void>((resolve) => {
			const unsubscribe = session.subscribe((event) => {
				if (event.type !== "message_update") return;
				unsubscribe();
				resolve();
			});
		});

		const promptPromise = session.prompt("hi");
		await sawMessageUpdate;
		await session.abort();
		await promptPromise;

		expect(events).toEqual(["model_request_start", "model_request_end"]);
	});
});
