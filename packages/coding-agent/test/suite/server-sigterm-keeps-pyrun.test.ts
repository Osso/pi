import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { withHeadlessPi } from "./headless-pi.ts";
import { type Frame, startDaemon, stopDaemon } from "./server-daemon-fixture.ts";

// pi-server.service restarts SIGTERM every worker; the server reopens each one, and a running call must finish.
it("a pyrun_eval call running when the pi server is SIGTERMed finishes and reports to the reopened session", async () => {
	await withHeadlessPi(async (agent) => {
		const first = await startDaemon(agent, null);
		let restarted: Awaited<ReturnType<typeof startDaemon>> | undefined;
		const marker = join(agent.paths.workspaceDir, "marker.txt");
		try {
			const started = await first.client.request("start_session", { cwd: agent.paths.workspaceDir });
			const session = (started.data as { session: Frame }).session;
			await first.client.request("attach_session", { sessionId: session.sessionId, mode: "control" });
			await first.client.request("session_rpc", {
				sessionId: session.sessionId,
				runtimeInstanceId: session.runtimeInstanceId,
				command: { type: "prompt", message: "Run the job." },
			});
			const cut = await agent.waitForLlmRequest((item) => item.userMessages.includes("Run the job."));
			const code = `import time\ntime.sleep(4)\nopen(${JSON.stringify(marker)}, "w").write("done")\nprint("job-finished")`;
			agent.respondToLlmRequest(
				cut.id,
				fauxAssistantMessage([fauxToolCall("pyrun_eval", { code })], { stopReason: "toolUse" }),
			);
			await first.client.waitForEvent(
				(event) =>
					event.sessionId === session.sessionId &&
					(event.event as Frame | undefined)?.type === "tool_execution_start",
			);
			await new Promise((resolve) => setTimeout(resolve, 1500));
			first.client.close();
			await new Promise<void>((resolve) => {
				first.daemon.once("exit", () => resolve());
				first.daemon.kill("SIGTERM");
			});
			restarted = await startDaemon(agent, null);
			const resumed = await agent.waitForLlmRequest(
				(item) => item !== cut && item.userMessages.includes("Run the job."),
			);
			expect(JSON.stringify(resumed)).not.toContain("Pyrun runner exited before producing a result");
			agent.respondToLlmRequest(
				resumed.id,
				fauxAssistantMessage([fauxToolCall("end_turn", { reason: "waiting" })], { stopReason: "toolUse" }),
			);
			const completion = await agent.waitForLlmRequest((item) => JSON.stringify(item).includes("job-finished"));
			agent.respondToLlmRequest(
				completion.id,
				fauxAssistantMessage([fauxToolCall("end_turn", { reason: "done" })], { stopReason: "toolUse" }),
			);
			expect(readFileSync(marker, "utf8")).toBe("done");
		} finally {
			first.client.close();
			if (restarted) {
				restarted.client.close();
				await stopDaemon(restarted.daemon, restarted.runtimeDir);
			}
			await stopDaemon(first.daemon, first.runtimeDir);
		}
	});
}, 90_000);
