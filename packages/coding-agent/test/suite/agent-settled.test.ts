import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function setup(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
	const harness = await createHarness({ noSupervisor: true, ...options });
	harnesses.push(harness);
	harness.session.setActiveToolsByName([]);
	return harness;
}

describe("agent_settled", () => {
	it("emits once after agent_end and pending bash messages are committed", async () => {
		const harness = await setup();
		harness.setResponses([fauxAssistantMessage("done")]);
		harness.session.subscribe((event) => {
			if (event.type === "agent_start") {
				harness.session.recordBashResult("echo test", {
					output: "test",
					exitCode: 0,
					cancelled: false,
					truncated: false,
				});
			}
		});
		await harness.session.prompt("hello");
		expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: false }]);
		const types = harness.events.map((event) => event.type);
		expect(types.indexOf("agent_settled")).toBeGreaterThan(types.indexOf("agent_end"));
		expect(types.indexOf("agent_settled")).toBeGreaterThan(types.indexOf("bash_messages_committed"));
	});

	it("waits through retry and follow-up queued by an agent_end handler", async () => {
		let harness: Harness;
		let queued = false;
		harness = await setup({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", async (event) => {
						if (
							!queued &&
							event.messages.some((message) => message.role === "assistant" && message.stopReason === "stop")
						) {
							queued = true;
							await harness.session.followUp("next");
						}
					});
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
			fauxAssistantMessage("continued"),
		]);
		await harness.session.prompt("hello");
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("agent_end")).toHaveLength(3);
		expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: false }]);
		expect(harness.events.at(-1)?.type).toBe("agent_settled");
	});

	it("marks a cancelled run after the provider exits", async () => {
		const harness = await setup();
		let started!: () => void;
		const providerStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const waitForAbort: FauxResponseFactory = async (_context, options) => {
			started();
			const signal = options?.signal;
			if (!signal) throw new Error("Expected abort signal");
			if (!signal.aborted)
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			return fauxAssistantMessage("cancelled", { stopReason: "aborted" });
		};
		harness.setResponses([waitForAbort]);
		const prompt = harness.session.prompt("hello");
		await providerStarted;
		await harness.session.abort();
		await prompt;
		expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: true }]);
		expect(harness.events.map((event) => event.type).lastIndexOf("agent_end")).toBeLessThan(
			harness.events.map((event) => event.type).indexOf("agent_settled"),
		);
	});

	it.each([
		{ stopReason: "error" as const, aborted: false },
		{ stopReason: "aborted" as const, aborted: true },
	])("reports provider $stopReason without retry", async ({ stopReason, aborted }) => {
		const harness = await setup({ settings: { retry: { enabled: false } } });
		harness.setResponses([fauxAssistantMessage("", { stopReason, errorMessage: "provider stopped" })]);
		await harness.session.prompt("hello");
		expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted }]);
	});

	it("does not settle a prompt rejected before dispatch", async () => {
		const harness = await setup({ withConfiguredAuth: false });
		await expect(harness.session.prompt("hello")).rejects.toThrow();
		expect(harness.eventsOfType("agent_settled")).toEqual([]);
	});
});
