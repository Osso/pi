import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

// Runs started by sendMessage(..., { triggerTurn: true }) or continue() skipped before_agent_start. The first such
// run in a process (for example after a restart) used the base system prompt without extension additions such as
// the goal block or the Supervisor policy, and later ones reused the additions of the previous user prompt.
describe("before_agent_start for runs that no user prompt started", () => {
	let harness: Harness | undefined;

	afterEach(() => harness?.cleanup());

	async function createRecordingHarness() {
		let handlerRuns = 0;
		const prompts: string[] = [];
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						handlerRuns++;
						prompts.push(event.prompt);
						return { systemPrompt: `${event.systemPrompt}\n\nEXTENSION-BLOCK-${handlerRuns}` };
					});
				},
			],
		});
		const blocks: string[] = [];
		harness.setResponses(
			Array.from({ length: 6 }, () => (context: { systemPrompt?: string }) => {
				blocks.push(context.systemPrompt?.match(/EXTENSION-BLOCK-\d+/)?.[0] ?? "none");
				return fauxAssistantMessage([fauxToolCall("end_turn", { reason: "done" })], { stopReason: "toolUse" });
			}),
		);
		return { harness, blocks, prompts };
	}

	it("applies fresh extension additions to custom-message runs", async () => {
		const { harness, blocks, prompts } = await createRecordingHarness();

		await harness.session.sendCustomMessage(
			{ customType: "note", content: "first", display: true },
			{ triggerTurn: true },
		);
		await harness.session.prompt("hello");
		await harness.session.sendCustomMessage(
			{ customType: "note", content: "second", display: true },
			{ triggerTurn: true },
		);

		expect(blocks).toEqual(["EXTENSION-BLOCK-1", "EXTENSION-BLOCK-2", "EXTENSION-BLOCK-3"]);
		expect(prompts).toEqual(["", "hello", ""]);
	});

	it("applies extension additions to continue() and idle steering runs", async () => {
		const { harness, blocks } = await createRecordingHarness();
		harness.sessionManager.appendMessage({ role: "user", content: "restored request", timestamp: 1 });
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		await harness.session.continue();
		await harness.session.steer("steer while idle");
		await harness.session.agent.waitForIdle();

		expect(blocks).toEqual(["EXTENSION-BLOCK-1", "EXTENSION-BLOCK-2"]);
	});
});
