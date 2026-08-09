import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import {
	findActiveSessionMetadataById,
	getControlDbPath,
	listSessionHealth,
	readSessionSandboxProfile,
} from "../../../src/core/session-control-db.ts";
import type { HeadlessLlmRequest, HeadlessPi } from "../headless-pi.ts";
import { withHeadlessPi } from "../headless-pi.ts";

const canExecuteBwrap =
	spawnSync(
		"bwrap",
		[
			"--unshare-all",
			"--share-net",
			"--ro-bind",
			"/usr",
			"/usr",
			"--ro-bind",
			"/bin",
			"/bin",
			"--ro-bind",
			"/lib",
			"/lib",
			"--ro-bind",
			"/lib64",
			"/lib64",
			"--ro-bind",
			"/etc",
			"/etc",
			"--dev",
			"/dev",
			"--proc",
			"/proc",
			"--",
			"/usr/bin/true",
		],
		{ encoding: "utf8" },
	).status === 0;

function createSymlinkedPyrunRunner(root: string): string {
	const target = join(root, "runner", "pyrun-jsonl.mjs");
	const link = join(root, "bin", "pyrun-jsonl");
	mkdirSync(join(root, "runner"), { recursive: true });
	mkdirSync(join(root, "bin"), { recursive: true });
	writeFileSync(
		target,
		`#!${process.execPath}
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ executed: request.code, type: "completed", value: "sandbox-pyrun-ok" }) + "\\n");
});
`,
		{ mode: 0o755 },
	);
	chmodSync(target, 0o755);
	symlinkSync(target, link);
	return link;
}

async function finishToolTurn(agent: HeadlessPi, request: HeadlessLlmRequest): Promise<void> {
	const toolCallId = `end-${request.id}`;
	agent.respondToLlmRequest(
		request.id,
		fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Tool result observed" }, { id: toolCallId }), {
			stopReason: "toolUse",
		}),
	);
	await agent.waitForSessionEntry(
		null,
		(entry) =>
			entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === toolCallId,
	);
	await agent.waitForEvent((event) => event.type === "agent_end");
}

async function callTool(
	agent: HeadlessPi,
	input: { name: string; args: Record<string, unknown>; id: string },
): Promise<HeadlessLlmRequest> {
	await agent.send({ type: "prompt", message: `Run ${input.name}` });
	const request = await agent.waitForLlmRequest((candidate) => candidate.agentId === null);
	agent.respondToLlmRequest(
		request.id,
		fauxAssistantMessage(fauxToolCall(input.name, input.args, { id: input.id }), { stopReason: "toolUse" }),
	);
	return agent.waitForLlmRequest(
		(candidate) =>
			candidate.agentId === null &&
			candidate.id !== request.id &&
			candidate.messages.some((message) => message.role === "toolResult" && message.toolCallId === input.id),
	);
}

function toolResult(request: HeadlessLlmRequest, toolCallId: string) {
	const result = request.messages.find(
		(message) => message.role === "toolResult" && message.toolCallId === toolCallId,
	);
	if (!result || result.role !== "toolResult") throw new Error(`Missing tool result ${toolCallId}`);
	return result;
}

it.skipIf(!canExecuteBwrap)(
	"keeps one session read-only across restart without leaking into a new session",
	async () => {
		const runnerRoot = mkdtempSync(join(tmpdir(), "pi-session-sandbox-runner-"));
		const runnerLink = createSymlinkedPyrunRunner(runnerRoot);
		try {
			await withHeadlessPi(
				async (agent) => {
					await agent.waitForExtensionUiRequest(
						(request) =>
							request.method === "setStatus" &&
							request.statusKey === "bwrap" &&
							request.statusText?.includes("full access") === true,
					);

					await agent.send({ type: "prompt", message: "/sandbox read-only session" });
					await agent.waitForExtensionUiRequest(
						(request) =>
							request.method === "setStatus" &&
							request.statusKey === "bwrap" &&
							request.statusText?.includes("read-only") === true,
					);
					const originalSessionId = agent.sessionId;
					const originalSessionFile = agent.sessionFile;
					const controlDbPath = getControlDbPath(agent.paths.agentDir);
					expect(readSessionSandboxProfile(controlDbPath, originalSessionFile, originalSessionId)).toBe("read-only");

					await agent.restart();
					await agent.waitForExtensionUiRequest(
						(request) =>
							request.method === "setStatus" &&
							request.statusKey === "bwrap" &&
							request.statusText?.includes("read-only") === true,
					);
					expect(readSessionSandboxProfile(controlDbPath, originalSessionFile, originalSessionId)).toBe("read-only");

					const blockedWrite = await callTool(agent, {
						args: { content: "blocked", path: "read-only-probe.txt" },
						id: "read-only-write",
						name: "write",
					});
					expect(toolResult(blockedWrite, "read-only-write")).toMatchObject({ isError: true });
					expect(existsSync(join(agent.paths.workspaceDir, "read-only-probe.txt"))).toBe(false);
					await finishToolTurn(agent, blockedWrite);

					const pyrun = await callTool(agent, {
						args: { code: "print('sandbox-pyrun-ok')" },
						id: "read-only-pyrun",
						name: "pyrun_eval",
					});
					expect(toolResult(pyrun, "read-only-pyrun")).toMatchObject({ isError: false });
					expect(JSON.stringify(toolResult(pyrun, "read-only-pyrun"))).toContain("sandbox-pyrun-ok");
					await finishToolTurn(agent, pyrun);

					const newSession = await agent.send({ type: "new_session" });
					expect(newSession).toMatchObject({ command: "new_session", success: true });
					await agent.waitForExtensionUiRequest(
						(request) =>
							request.method === "setStatus" &&
							request.statusKey === "bwrap" &&
							request.statusText?.includes("full access") === true,
					);
					const liveSession = listSessionHealth(controlDbPath).find(
						(health) => health.checkStatus === "ok" && health.sessionId !== originalSessionId,
					);
					if (!liveSession) throw new Error("New live session was not registered");
					const [newMetadata] = findActiveSessionMetadataById(controlDbPath, liveSession.sessionId);
					if (!newMetadata) throw new Error("New session metadata was not registered");
					expect(readSessionSandboxProfile(controlDbPath, newMetadata.sessionPath, liveSession.sessionId)).toBeUndefined();
					expect(readSessionSandboxProfile(controlDbPath, originalSessionFile, originalSessionId)).toBe("read-only");

					const allowedWrite = await callTool(agent, {
						args: { content: "allowed", path: "full-access-probe.txt" },
						id: "full-access-write",
						name: "write",
					});
					expect(toolResult(allowedWrite, "full-access-write")).toMatchObject({ isError: false });
					expect(existsSync(join(agent.paths.workspaceDir, "full-access-probe.txt"))).toBe(true);
				},
				{
					env: {
						PI_PYRUN_RUNNER_ARGS: "[]",
						PI_PYRUN_RUNNER_COMMAND: runnerLink,
					},
					sandboxProfile: "full-access",
				},
			);
		} finally {
			rmSync(runnerRoot, { force: true, recursive: true });
		}
	},
	30_000,
);
