import { createConnection, type Socket } from "node:net";
import { expect, it } from "vitest";
import { getDebugSocketPath } from "../../src/core/debug-repl.ts";
import { getControlDbPath, listSessionHealth } from "../../src/core/session-control-db.ts";
import { withHeadlessPi } from "./headless-pi.ts";

function readUntil(socket: Socket, marker: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let output = "";
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
			socket.off("data", onData);
			socket.off("error", onError);
		};
		socket.on("data", onData);
		socket.once("error", onError);
	});
}

function connectDebugRepl(socketPath: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		socket.once("connect", () => {
			socket.write(`${JSON.stringify({ pid: process.pid })}\n`);
			resolve(socket);
		});
		socket.once("error", reject);
	});
}

it("keeps the privileged REPL bound to live runtime state across real session replacement", async () => {
	await withHeadlessPi(async (agent) => {
		await agent.send({ type: "prompt", message: "/debug" });
		const controlDbPath = getControlDbPath(agent.paths.agentDir);
		const initialHealth = listSessionHealth(controlDbPath).find((health) => health.checkStatus === "ok");
		if (!initialHealth?.pid) throw new Error("Headless session health was not available");

		const socket = await connectDebugRepl(getDebugSocketPath(agent.paths.agentDir, initialHealth.pid));
		await readUntil(socket, "pi> ");
		socket.write("pi.session.sessionId\n");
		const initialOutput = await readUntil(socket, "pi> ");
		expect(initialOutput).toContain(initialHealth.sessionId);

		await agent.send({ type: "new_session" });
		const replacementHealth = listSessionHealth(controlDbPath).find(
			(health) => health.checkStatus === "ok" && health.sessionId !== initialHealth.sessionId,
		);
		if (!replacementHealth) throw new Error("Replacement session health was not available");

		socket.write("pi.session.sessionId\n");
		const replacementOutput = await readUntil(socket, "pi> ");
		expect(replacementOutput).toContain(replacementHealth.sessionId);
		expect(replacementOutput).not.toContain(initialHealth.sessionId);

		socket.write(".exit\n");
		await agent.send({ type: "prompt", message: "/debug off" });
	});
});
