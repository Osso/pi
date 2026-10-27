import { existsSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { getMessageText } from "./harness.ts";
import { withHeadlessPi } from "./headless-pi.ts";

const runner = process.env.PI_PYRUN_INSTALLED_RUNNER;

it.skipIf(!runner || !existsSync(runner))(
	"routes installed Python agent calls to a real child and preserves errors",
	async () => {
		await withHeadlessPi(
			async (agent) => {
				await agent.send({ type: "prompt", message: "Start a child" });
				const initial = await agent.waitForLlmRequest((request) => request.agentId === null);
				agent.respondToLlmRequest(
					initial.id,
					fauxAssistantMessage(
						fauxToolCall("spawn_agent", { context: "fresh", displayName: "Python bridge child", prompt: "Wait" }),
						{ stopReason: "toolUse" },
					),
				);
				const child = await agent.waitForAgent((candidate) => candidate.lifecycle === "running");
				await agent.waitForLlmRequest((request) => request.agentId === child.id);
				let parent = await agent.waitForLlmRequest((request) => request.agentId === null);
				for (const [id, code, body] of [
					[
						"python-send",
						`pi.agents.send_message(${JSON.stringify(child.id)}, "Python mailbox message")`,
						"Python mailbox message",
					],
					[
						"python-steer",
						`pi.agents.steer(${JSON.stringify(child.id)}, "Python mailbox steering")`,
						"Python mailbox steering",
					],
				] as const) {
					agent.respondToLlmRequest(
						parent.id,
						fauxAssistantMessage(fauxToolCall("pyrun_eval", { code }, { id }), { stopReason: "toolUse" }),
					);
					parent = await agent.waitForLlmRequest(
						(request) =>
							request.agentId === null &&
							request.messages.some((message) => message.role === "toolResult" && message.toolCallId === id),
					);
					const result = parent.messages.find(
						(message) => message.role === "toolResult" && message.toolCallId === id,
					);
					expect(result, getMessageText(result)).toMatchObject({ isError: false });
					expect(agent.listRuntimeMailboxMessages()).toEqual(
						expect.arrayContaining([
							expect.objectContaining({ body, recipient: expect.objectContaining({ agentId: child.id }) }),
						]),
					);
				}
				for (const [id, code, error] of [
					[
						"python-missing-send",
						'pi.agents.send_message("missing-agent", "hello")',
						"Could not send agent message from main to missing-agent: target_not_found",
					],
					[
						"python-missing-steer",
						'pi.agents.steer("missing-agent", "hello")',
						"Could not steer missing-agent: not_found",
					],
				] as const) {
					agent.respondToLlmRequest(
						parent.id,
						fauxAssistantMessage(fauxToolCall("pyrun_eval", { code }, { id }), { stopReason: "toolUse" }),
					);
					parent = await agent.waitForLlmRequest(
						(request) =>
							request.agentId === null &&
							request.messages.some((message) => message.role === "toolResult" && message.toolCallId === id),
					);
					const result = parent.messages.find(
						(message) => message.role === "toolResult" && message.toolCallId === id,
					);
					expect(result, getMessageText(result)).toMatchObject({ isError: true });
					expect(getMessageText(result)).toContain(error);
				}
			},
			{ env: { PI_PYRUN_RUNNER_COMMAND: runner, PI_PYRUN_RUNNER_ARGS: "[]" } },
		);
	},
	60_000,
);
