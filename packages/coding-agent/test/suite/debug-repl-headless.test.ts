import { existsSync, readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { expect, it } from "vitest";
import { getDebugSocketPath } from "../../src/core/debug-repl.ts";
import { getControlDbPath, listSessionHealth } from "../../src/core/session-control-db.ts";
import { withHeadlessPi } from "./headless-pi.ts";

function readUntil(socket: Socket, marker: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let output = "";
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error(`Timed out waiting for ${JSON.stringify(marker)} in ${JSON.stringify(output)}`));
		}, 2000);
		const onData = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (!output.includes(marker)) return;
			cleanup();
			resolve(output);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const cleanup = () => {
			clearTimeout(timeout);
			socket.off("data", onData);
			socket.off("error", onError);
		};
		socket.on("data", onData);
		socket.once("error", onError);
	});
}

function connectDebugRepl(socketPath: string, sessionId: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		socket.once("connect", () => {
			socket.write(`${JSON.stringify({ pid: process.pid, sessionId })}\n`);
			resolve(socket);
		});
		socket.once("error", reject);
	});
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!existsSync(path)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function createEvaluationSettledBySocketFinish(startedPath: string): string {
	return [
		"new Promise((resolve, reject) => {",
		"const socket = process._getActiveHandles().find((handle) => handle?.server?.listening && handle.writable);",
		'if (!socket) { reject(new Error("Debug socket not found")); return; }',
		'socket.once("finish", () => resolve(1));',
		`process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(startedPath)}, "");`,
		"})",
	].join(" ");
}

it("does not crash when an in-flight evaluation settles after the client exits", async () => {
	await withHeadlessPi(async (agent) => {
		await agent.send({ type: "prompt", message: "/debug" });
		const controlDbPath = getControlDbPath(agent.paths.agentDir);
		const health = listSessionHealth(controlDbPath).find((entry) => entry.checkStatus === "ok");
		if (!health?.pid) throw new Error("Headless session health was not available");

		const startedPath = join(agent.paths.tempDir, "evaluation-started");
		const auditPath = join(agent.paths.agentDir, "debug", "audit.jsonl");
		const socket = await connectDebugRepl(getDebugSocketPath(agent.paths.agentDir, health.pid), health.sessionId);
		await readUntil(socket, "pi> ");
		socket.write(`${createEvaluationSettledBySocketFinish(startedPath)}\n`);
		await waitForFile(startedPath);

		const closed = new Promise<void>((resolve) => socket.once("close", resolve));
		socket.write(".exit\n");
		await Promise.all([closed, waitForFile(auditPath)]);

		const auditRecord = JSON.parse(readFileSync(auditPath, "utf8").trim()) as Record<string, unknown>;
		expect(auditRecord).toMatchObject({
			claimedClientPid: process.pid,
			sessionId: health.sessionId,
			status: "success",
		});
		const state = await agent.send({ type: "get_state" });
		expect(state).toMatchObject({ command: "get_state", success: true });
	});
});

it("keeps the privileged REPL bound to live runtime state across real session replacement", async () => {
	await withHeadlessPi(async (agent) => {
		await agent.send({ type: "prompt", message: "/debug" });
		const controlDbPath = getControlDbPath(agent.paths.agentDir);
		const initialHealth = listSessionHealth(controlDbPath).find((health) => health.checkStatus === "ok");
		if (!initialHealth?.pid) throw new Error("Headless session health was not available");

		const socket = await connectDebugRepl(
			getDebugSocketPath(agent.paths.agentDir, initialHealth.pid),
			initialHealth.sessionId,
		);
		await readUntil(socket, "pi> ");
		socket.write("pi.session.sessionId\n");
		const initialOutput = await readUntil(socket, initialHealth.sessionId);
		expect(initialOutput).toContain(initialHealth.sessionId);

		const replacement = agent.send({ type: "new_session" });
		socket.write("1 + 1\n");
		const duringReplacementOutput = await readUntil(socket, "2");
		expect(duringReplacementOutput).toContain("2");
		await replacement;
		const replacementHealth = listSessionHealth(controlDbPath).find(
			(health) => health.checkStatus === "ok" && health.sessionId !== initialHealth.sessionId,
		);
		if (!replacementHealth) throw new Error("Replacement session health was not available");

		socket.write("pi.session.sessionId\n");
		const replacementOutput = await readUntil(socket, replacementHealth.sessionId);
		expect(replacementOutput).toContain(replacementHealth.sessionId);
		expect(replacementOutput).not.toContain(initialHealth.sessionId);

		socket.write(".exit\n");
		await agent.send({ type: "prompt", message: "/debug off" });
	});
});
