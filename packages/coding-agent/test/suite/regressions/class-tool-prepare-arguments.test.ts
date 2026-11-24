import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../../src/core/extensions/types.ts";
import { createHarness, getMessageText } from "../harness.ts";

const echoSchema = Type.Object({ text: Type.String() });

/** A tool definition built as a class instance: prepareArguments lives on the prototype. */
class EchoTool implements ToolDefinition<typeof echoSchema> {
	name = "echo_text";
	label = "Echo text";
	description = "Echo text";
	parameters = echoSchema;

	prepareArguments(args: unknown): Static<typeof echoSchema> {
		const input = args as { text?: string; oldText?: string };
		return { text: input.text ?? input.oldText ?? "" };
	}

	async execute(_toolCallId: string, params: Static<typeof echoSchema>) {
		return { content: [{ type: "text" as const, text: `echo: ${params.text}` }], details: undefined };
	}
}

describe("class-based extension tool", () => {
	it("runs a prototype prepareArguments before validation", async () => {
		const harness = await createHarness({ extensionFactories: [(pi) => pi.registerTool(new EchoTool())] });
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("echo_text", { oldText: "legacy" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.bindExtensions({ mode: "print" });
			await harness.session.prompt("echo");

			const result = harness.session.messages.find((message) => message.role === "toolResult");
			expect(result).toMatchObject({ isError: false });
			expect(getMessageText(result)).toBe("echo: legacy");
		} finally {
			harness.cleanup();
		}
	});
});
