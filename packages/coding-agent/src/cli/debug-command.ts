import { createConnection } from "node:net";
import type { Readable, Writable } from "node:stream";
import { getDebugSocketPath } from "../core/debug-repl.ts";
import { getControlDbPath, readSessionHealth } from "../core/session-control-db.ts";

interface DebugCommandDependencies {
	agentDir: string;
	attach?: (socketPath: string) => Promise<void>;
	stderr?: (text: string) => void;
}

export async function handleDebugCommand(args: string[], dependencies: DebugCommandDependencies): Promise<boolean> {
	if (args[0] !== "debug") return false;

	const stderr = dependencies.stderr ?? ((text) => process.stderr.write(text));
	if (args.length !== 3 || args[1] !== "attach") {
		stderr("Usage: pi debug attach <session-id>\n");
		process.exitCode = 1;
		return true;
	}

	const sessionId = args[2];
	const health = readSessionHealth(getControlDbPath(dependencies.agentDir), sessionId);
	if (!health?.pid || health.checkStatus !== "ok") {
		stderr(`Session ${sessionId} is not running.\n`);
		process.exitCode = 1;
		return true;
	}

	const socketPath = getDebugSocketPath(dependencies.agentDir, health.pid);
	const attach = dependencies.attach ?? ((path) => attachDebugRepl(path, process.stdin, process.stdout));
	try {
		await attach(socketPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		stderr(`Could not attach to debug REPL for session ${sessionId}: ${message}\n`);
		process.exitCode = 1;
	}
	return true;
}

export function attachDebugRepl(socketPath: string, input: Readable, output: Writable): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		const cleanup = () => {
			input.unpipe(socket);
			socket.unpipe(output);
		};
		socket.once("connect", () => {
			socket.write(`${JSON.stringify({ pid: process.pid })}\n`);
			input.pipe(socket);
			socket.pipe(output);
		});
		socket.once("close", () => {
			cleanup();
			resolve();
		});
		socket.once("error", (error) => {
			cleanup();
			reject(error);
		});
	});
}
