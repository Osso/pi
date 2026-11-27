import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withHeadlessPi } from "./headless-pi.ts";
import { type Frame, localHubCommand, startDaemon, stopDaemon } from "./server-daemon-fixture.ts";

async function waitForSpoke(hub: { request(type: string, fields?: Frame): Promise<Frame> }): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const machines = ((await hub.request("list_machines")).data as { machines: Frame[] }).machines;
		if (machines.some((machine) => machine.hostId === "spoke-id" && machine.status === "online")) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("Timed out waiting for spoke server");
}

async function callTool(
	client: { request(type: string, fields?: Frame): Promise<Frame> },
	sessionId: string,
	runtimeInstanceId: string,
	toolName: string,
	params: Frame,
): Promise<Frame> {
	const response = await client.request("session_rpc", {
		sessionId,
		runtimeInstanceId,
		command: { type: "call_tool", toolName, params },
	});
	const rpcResponse = (response.data as Frame).response as Frame;
	return (rpcResponse.data as { result: Frame }).result;
}

async function runningSpokeSessions(client: { request(type: string, fields?: Frame): Promise<Frame> }) {
	const sessions = ((await client.request("list_sessions")).data as { sessions: Frame[] }).sessions;
	return sessions.filter((session) => session.owner === "server" && session.status === "running");
}

function resultText(result: Frame): string {
	return (result.content as Array<{ text?: string }>).map((item) => item.text ?? "").join("\n");
}

it("routes bash, Pyrun, and browser-cli tools through the pi server hub and reports unknown hosts", async () => {
	const stubDir = mkdtempSync(join(tmpdir(), "pi-remote-browser-cli-"));
	const browserCli = join(stubDir, "browser-cli");
	writeFileSync(
		browserCli,
		[
			"#!/usr/bin/env node",
			"console.log(process.env.PI_SERVER_HOST_ID + ':' + process.env.BROWSER_CLI_SESSION);",
			"",
		].join("\n"),
	);
	chmodSync(browserCli, 0o755);
	const originalPath = process.env.PATH;
	process.env.PATH = `${stubDir}:${originalPath ?? ""}`;
	try {
		await withHeadlessPi(async (hubAgent) => {
			await withHeadlessPi(async (spokeAgent) => {
				const hub = await startDaemon(hubAgent, null, { hostId: "hub-id", hub: "hub-id" });
				const spoke = await startDaemon(spokeAgent, null, {
					hostId: "spoke-id",
					hub: "hub-id",
					hubCommand: localHubCommand(hub.runtimeDir),
				});
				try {
					await waitForSpoke(hub.client);
					const started = await hub.client.request("start_session", { cwd: hubAgent.paths.workspaceDir });
					const sessionId = String((started.data as { session: Frame }).session.sessionId);
					const attached = await hub.client.request("attach_session", { sessionId, mode: "control" });
					const runtimeInstanceId = String(attached.data && (attached.data as Frame).runtimeInstanceId);

					const bash = await callTool(hub.client, sessionId, runtimeInstanceId, "bash", {
						host: "spoke-id",
						cwd: spokeAgent.paths.workspaceDir,
						command: 'printf "%s\\n%s\\n%s\\n" "$PI_SERVER_HOST_ID" "$PWD" "$(hostname)"',
					});
					expect(bash.isError).not.toBe(true);
					expect(resultText(bash)).toContain("spoke-id");
					expect(resultText(bash)).toContain(spokeAgent.paths.workspaceDir);

					const pyrun = await callTool(hub.client, sessionId, runtimeInstanceId, "pyrun_eval", {
						host: "spoke-id",
						cwd: spokeAgent.paths.workspaceDir,
						code: "import os, socket; print(os.environ.get('PI_SERVER_HOST_ID')); print(os.getcwd()); print(socket.gethostname())",
					});
					expect(pyrun.isError, resultText(pyrun)).not.toBe(true);
					expect(resultText(pyrun)).toContain("spoke-id");
					expect(resultText(pyrun)).toContain(spokeAgent.paths.workspaceDir);

					const browser = await callTool(hub.client, sessionId, runtimeInstanceId, "browser-cli", {
						host: "spoke-id",
						commands: [["get", "url"]],
					});
					expect(browser.isError).not.toBe(true);
					expect(resultText(browser)).toContain("spoke-id:");
					// A second call reuses the remote session, so browser-cli keeps the same tab key.
					const browserAgain = await callTool(hub.client, sessionId, runtimeInstanceId, "browser-cli", {
						host: "spoke-id",
						commands: [["get", "url"]],
					});
					expect(resultText(browserAgain).trim()).toBe(resultText(browser).trim());

					const unknown = await callTool(hub.client, sessionId, runtimeInstanceId, "bash", {
						host: "unknown-id",
						command: "true",
					});
					expect(unknown.isError).toBe(true);
					expect(resultText(unknown)).toContain("machine_offline");

					// Ending the local session stops the remote tool sessions it opened on the spoke.
					expect(await runningSpokeSessions(spoke.client)).not.toHaveLength(0);
					await hub.client.request("stop_session", { sessionId, runtimeInstanceId });
					const deadline = Date.now() + 30_000;
					while ((await runningSpokeSessions(spoke.client)).length > 0 && Date.now() < deadline)
						await new Promise((resolve) => setTimeout(resolve, 100));
					expect(await runningSpokeSessions(spoke.client)).toHaveLength(0);
				} finally {
					hub.client.close();
					spoke.client.close();
					await stopDaemon(spoke.daemon, spoke.runtimeDir);
					await stopDaemon(hub.daemon, hub.runtimeDir);
				}
			});
		});
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		rmSync(stubDir, { recursive: true, force: true });
	}
}, 180_000);
