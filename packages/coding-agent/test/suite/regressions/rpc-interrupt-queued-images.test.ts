import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ImageContent, Message } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness } from "../harness.ts";
import { withHeadlessPi } from "../headless-pi.ts";

const image: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8ioAAAAASUVORK5CYII=",
};

describe("RPC interrupt queued images", () => {
	it("preserves queued images and the editor draft through the interactive interrupt handler", async () => {
		const harness = await createHarness();
		let announceStart = () => {};
		const started = new Promise<void>((resolve) => {
			announceStart = resolve;
		});
		let replacement: Message | undefined;
		harness.setResponses([
			async (_context, options) => {
				announceStart();
				await new Promise<void>((resolve) => {
					options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("Interrupted", { stopReason: "aborted" });
			},
			(context) => {
				replacement = context.messages.at(-1);
				return fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Image preserved" }), {
					stopReason: "toolUse",
				});
			},
		]);
		const initial = harness.session.prompt("Start a long response");
		try {
			await started;
			await harness.session.followUp("Describe this image", [image]);
			const editor = {
				text: "Include its colors",
				getText() {
					return this.text;
				},
				setText(text: string) {
					this.text = text;
				},
			};
			const handlers = InteractiveMode.prototype as unknown as {
				cancelStreamingAndSubmitQueuedMessages(this: unknown): Promise<void>;
				clearAllQueues(this: unknown): unknown;
			};
			await handlers.cancelStreamingAndSubmitQueuedMessages.call({
				clearAllQueues() {
					return handlers.clearAllQueues.call(this);
				},
				session: harness.session,
				compactionQueuedMessages: [],
				editor,
				updatePendingMessagesDisplay() {},
			});
			await initial;
			expect(replacement).toMatchObject({
				role: "user",
				content: [{ type: "text", text: "Describe this image\n\nInclude its colors" }, image],
			});
			expect(editor.text).toBe("");
			expect(harness.session.pendingMessageCount).toBe(0);
		} finally {
			await harness.session.abort();
			await initial;
			harness.cleanup();
		}
	});

	it.each(["Describe this image", ""])(
		"preserves a follow-up image with text %j during model thinking",
		async (message) => {
			await withHeadlessPi(async (agent) => {
				await agent.send({ type: "prompt", message: "Start a long response" });
				const initial = await agent.waitForLlmRequest();
				await agent.send({ type: "follow_up", message, images: [image] });
				await agent.send({ type: "interrupt" });

				const replacement = await agent.waitForLlmRequest((request) => request.id !== initial.id);
				expect(replacement.messages.at(-1)).toMatchObject({
					role: "user",
					content: [{ type: "text", text: message }, image],
				});
				agent.respondToLlmRequest(
					replacement.id,
					fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Image preserved" }), { stopReason: "toolUse" }),
				);
			});
		},
	);

	it.each(["steer", "follow_up"] as const)("preserves %s images while interrupting a tool", async (type) => {
		await withHeadlessPi(async (agent) => {
			await agent.send({ type: "prompt", message: "Wait in Pyrun" });
			const initial = await agent.waitForLlmRequest();
			agent.respondToLlmRequest(
				initial.id,
				fauxAssistantMessage(fauxToolCall("pyrun_eval", { code: "import time\ntime.sleep(60)" }), {
					stopReason: "toolUse",
				}),
			);
			await agent.waitForEvent((event) => event.type === "tool_execution_start" && event.toolName === "pyrun_eval");
			await agent.send({ type, message: "Describe both images", images: [image, image] });
			await agent.send({ type: "follow_up", message: "Include their colors" });
			await agent.send({ type: "interrupt" });

			const replacement = await agent.waitForLlmRequest((request) => request.id !== initial.id);
			expect(replacement.messages.at(-1)).toMatchObject({
				role: "user",
				content: [{ type: "text", text: "Describe both images\n\nInclude their colors" }, image, image],
			});
			agent.respondToLlmRequest(
				replacement.id,
				fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Images preserved" }), { stopReason: "toolUse" }),
			);
		});
	});
});
