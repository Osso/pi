import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it, vi } from "vitest";
import { withHeadlessPi } from "./headless-pi.ts";

it("delivers one detached terminal notification after supervisor restart and never replays its deleted transport or outbox", async () => {
	await withHeadlessPi(
		async (agent) => {
			const startedPath = join(agent.paths.workspaceDir, "terminal-started");
			const releasePath = join(agent.paths.workspaceDir, "terminal-release");
			const code = [
				"from pathlib import Path",
				"import time",
				`started = Path(${JSON.stringify(startedPath)})`,
				`release = Path(${JSON.stringify(releasePath)})`,
				'started.write_text((started.read_text() if started.exists() else "") + "x")',
				"while not release.exists(): time.sleep(0.05)",
				'print("detached terminal complete")',
			].join("\n");
			await agent.send({ type: "prompt", message: "Start a job held across supervisor restart" });
			const initial = await agent.waitForLlmRequest((request) => request.agentId === null);
			agent.respondToLlmRequest(
				initial.id,
				fauxAssistantMessage(fauxToolCall("pyrun_eval", { code }), { stopReason: "toolUse" }),
			);
			await vi.waitFor(() => expect(existsSync(startedPath)).toBe(true), { timeout: 30_000 });
			const job = await agent.waitForAgent(
				(candidate) => candidate.displayName === "Pyrun evaluation" && candidate.lifecycle === "running",
			);
			expect(job.detached).toBe(true);
			const runnerPid = agent.getRunnerPid(job.id);
			expect(runnerPid).toBeDefined();
			void agent.send({ type: "prompt", message: "/restart" }).catch(() => undefined);
			const resumed = await agent.waitForLlmRequest(
				(request) =>
					request.agentId === null && JSON.stringify(request.messages).includes("The agent process was restarted"),
			);
			expect(agent.listAgents().find((candidate) => candidate.id === job.id)?.lifecycle).toBe("running");
			expect(agent.getRunnerPid(job.id)).toBe(runnerPid);
			writeFileSync(releasePath, "release");
			await agent.waitForAgent((candidate) => candidate.id === job.id && candidate.lifecycle === "completed");
			agent.respondToLlmRequest(
				resumed.id,
				fauxAssistantMessage(fauxToolCall("list_agents", {}), { stopReason: "toolUse" }),
			);
			const notice = await agent.waitForLlmRequest(
				(request) =>
					request.agentId === null && request.userMessages.some((text) => text.includes(`- agent: ${job.id}`)),
			);
			expect(notice.userMessages.filter((text) => text.includes(`- agent: ${job.id}`))).toHaveLength(1);
			expect(agent.listRuntimeMailboxMessages().filter((message) => message.sender.agentId === job.id)).toEqual([]);
			agent.respondToLlmRequest(
				notice.id,
				fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Terminal notification received" }), {
					stopReason: "toolUse",
				}),
			);
			await vi.waitFor(() => expect(agent.readTerminalOutboxStatuses(job.id)).toEqual([]));
			await agent.waitForSessionEntry(
				null,
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolName === "end_turn" &&
					JSON.stringify(entry.message.content).includes("Terminal notification received"),
			);
			await agent.restart();
			await agent.send({ type: "prompt", message: "Inspect notification history after listener rebind" });
			const probe = await agent.waitForLlmRequest((request) => request.agentId === null);
			expect(probe.userMessages.filter((text) => text.includes(`- agent: ${job.id}`))).toHaveLength(1);
			expect(agent.listRuntimeMailboxMessages().filter((message) => message.sender.agentId === job.id)).toEqual([]);
			expect(agent.readTerminalOutboxStatuses(job.id)).toEqual([]);
			expect(readFileSync(startedPath, "utf8")).toBe("x");
			await agent.send({ type: "abort" });
		},
		{ autoDetachTools: true },
	);
}, 90_000);
