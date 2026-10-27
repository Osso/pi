import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { getMessageText } from "./harness.ts";
import { withHeadlessPi } from "./headless-pi.ts";

it("routes Pyrun agent requests to a live child and raises tool errors", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pyrun-agent-bridge-"));
	const runner = join(dir, "runner.mjs");
	writeFileSync(
		runner,
		`
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
for (;;) {
  const input = await lines.next();
  if (input.done) break;
  const request = JSON.parse(input.value);
  const bridge = JSON.parse(request.code);
  process.stdout.write(JSON.stringify({type: 'pi_request', ...bridge}) + '\\n');
  const response = JSON.parse((await lines.next()).value);
  const result = response.error ? {type: 'error', error: response.error} : {type: 'completed', executed: request.code, value: response.result};
  process.stdout.write(JSON.stringify(result) + '\\n');
}
`,
	);
	try {
		await withHeadlessPi(
			async (agent) => {
				await agent.send({ type: "prompt", message: "Start a child" });
				const initial = await agent.waitForLlmRequest((request) => request.agentId === null);
				agent.respondToLlmRequest(
					initial.id,
					fauxAssistantMessage(
						fauxToolCall("spawn_agent", {
							context: "fresh",
							displayName: "Bridge child",
							prompt: "Wait for messages",
						}),
						{ stopReason: "toolUse" },
					),
				);
				const child = await agent.waitForAgent((candidate) => candidate.lifecycle === "running");
				await agent.waitForLlmRequest((request) => request.agentId === child.id);
				let parent = await agent.waitForLlmRequest((request) => request.agentId === null);
				for (const [method, params, body] of [
					[
						"agents.send_message",
						{ toAgentId: child.id, body: "Mailbox bridge message" },
						"Mailbox bridge message",
					],
					["agents.steer", { agentId: child.id, message: "Mailbox bridge steering" }, "Mailbox bridge steering"],
				] as const) {
					const id = `bridge-${method}`;
					agent.respondToLlmRequest(
						parent.id,
						fauxAssistantMessage(
							fauxToolCall("pyrun_eval", { code: JSON.stringify({ method, params }) }, { id }),
							{ stopReason: "toolUse" },
						),
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
				for (const [method, params] of [
					["agents.send_message", { toAgentId: "missing-agent", body: "hello" }],
					["agents.steer", { agentId: "missing-agent", message: "hello" }],
					["agents.send_message", { toAgentId: child.id, body: " " }],
				] as const) {
					const id = `error-${method}-${JSON.stringify(params)}`;
					agent.respondToLlmRequest(
						parent.id,
						fauxAssistantMessage(
							fauxToolCall("pyrun_eval", { code: JSON.stringify({ method, params }) }, { id }),
							{ stopReason: "toolUse" },
						),
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
					expect(getMessageText(result)).not.toContain("capability is unavailable");
				}
			},
			{ env: { PI_PYRUN_RUNNER_COMMAND: process.execPath, PI_PYRUN_RUNNER_ARGS: JSON.stringify([runner]) } },
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 60_000);
