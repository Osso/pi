import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

// pi.callTool (Pyrun pi.tools.call) must stop after a tool_call handler aborts, as the model tool path does (#8935).
it("does not run a nested tool call after its tool_call handler aborts the turn", async () => {
	const executions: string[] = [];
	const resultHooks: string[] = [];
	let nestedResult: { text: string; isError: boolean | undefined } | undefined;
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "echo",
					label: "Echo",
					description: "Echo text",
					parameters: Type.Object({ text: Type.String() }),
					execute: async (_toolCallId, params) => {
						executions.push(params.text);
						return { content: [{ type: "text", text: params.text }], details: undefined };
					},
				});
				pi.registerTool({
					name: "bridge",
					label: "Bridge",
					description: "Call echo through pi.callTool",
					parameters: Type.Object({ text: Type.String() }),
					execute: async (toolCallId, params, signal) => {
						const result = await pi.callTool("echo", params, signal, toolCallId);
						const block = result.content[0];
						nestedResult = { text: block?.type === "text" ? block.text : "", isError: result.isError };
						return result;
					},
				});
				pi.on("tool_call", async (event, ctx) => {
					if (event.toolName === "echo") ctx.abort();
				});
				pi.on("tool_result", async (event) => {
					if (event.toolName === "echo") resultHooks.push(event.toolCallId);
				});
			},
		],
	});
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("bridge", { text: "hello" }, { id: "call-1" }), { stopReason: "toolUse" }),
	]);

	await harness.session.prompt("bridge hello");

	expect(executions).toEqual([]);
	expect(resultHooks).toEqual([]);
	expect(nestedResult).toEqual({ text: "Operation aborted", isError: true });
});
