import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { withHeadlessPi } from "./headless-pi.ts";
import type { CanonicalPyrunEvalResult } from "../../extensions/pyrun/src/runner.ts";

describe("standalone worker real CLI", () => {
	it("executes canonical Pyrun commands and ordinary Pi tools with no Supervisor or coordination", async () => {
		await withHeadlessPi(
			async (agent) => {
				expect(agent.sessionFile).toBe("");
				expect(
					(await agent.send({ type: "prompt", message: "Write a worker fixture through Pyrun" })).success,
				).toBe(true);
				const first = await agent.waitForLlmRequest();
				const names = first.tools?.map((tool) => tool.name) ?? [];
				expect(names).toContain("pyrun_eval");
				for (const name of [
					"ask_supervisor",
					"manage_goal",
					"spawn_agent",
					"list_agents",
					"list_sessions",
					"channel_post",
				])
					expect(names).not.toContain(name);
				agent.respondToLlmRequest(
					first.id,
					fauxAssistantMessage(
						fauxToolCall("pyrun_eval", {
							code: "assert run.printf('standalone-command-ok\\n') == 0\nprint(pi.tools.call('write', {'path': 'worker.txt', 'content': 'foreground bridge works'}))\nprint(pi.tools.call('read', {'path': 'worker.txt'}))",
						}),
						{ stopReason: "toolUse" },
					),
				);
				const second = await agent.waitForLlmRequest();
				const result = second.messages.find(
					(message) => message.role === "toolResult" && message.toolName === "pyrun_eval",
				);
				expect(result).toMatchObject({ isError: false });
				if (result?.role !== "toolResult") throw new Error("Missing Pyrun tool result");
				const consoleOutput = (result.details as CanonicalPyrunEvalResult).console
					?.map((entry) => (typeof entry === "string" ? entry : entry.message))
					.join("\n");
				expect(consoleOutput).toContain("standalone-command-ok");
				expect(consoleOutput).toContain("foreground bridge works");
				expect(readFileSync(join(agent.paths.workspaceDir, "worker.txt"), "utf8")).toBe("foreground bridge works");
				agent.respondToLlmRequest(
					second.id,
					fauxAssistantMessage(
						fauxToolCall("pyrun_eval", {
							code: "for name in ['ask_supervisor', 'manage_goal', 'spawn_agent', 'channel_post']:\n    try:\n        pi.tools.call(name, {})\n    except Exception as error:\n        print(name, str(error))\ntry:\n    pi.agents.list()\nexcept Exception as error:\n    print(str(error))\ntry:\n    pi.sessions.resume({'name': 'nonexistent-worker-target'})\nexcept Exception as error:\n    print(str(error))",
						}),
						{ stopReason: "toolUse" },
					),
				);
				const third = await agent.waitForLlmRequest();
				const results = third.messages.filter(
					(message) => message.role === "toolResult" && message.toolName === "pyrun_eval",
				);
				expect(results).toHaveLength(2);
				expect(results[1]).toMatchObject({ isError: false });
				expect(JSON.stringify(results[1])).toContain("unavailable in standalone worker mode");
				agent.respondToLlmRequest(
					third.id,
					fauxAssistantMessage(fauxToolCall("end_turn", { reason: "worker complete" }), { stopReason: "toolUse" }),
				);
				await agent.waitForEvent((event) => event.type === "agent_end");
				expect(readdirSync(agent.paths.sessionDir)).toEqual([]);
				expect(agent.readSupervisorActivity()).toEqual({
					connections: 0,
					starts: 0,
					requests: 0,
					listeners: 0,
					cursors: 0,
					agents: 0,
				});
			},
			{ noSupervisor: true },
		);
	}, 60_000);
});
