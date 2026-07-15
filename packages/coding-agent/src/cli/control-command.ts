import {
	enqueueIncomingMessage,
	getControlDbPath,
	readLastMessage,
	readSessionHealth,
} from "../core/session-control-db.ts";

interface ControlCommandDependencies {
	agentDir: string;
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
	signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
}

interface ParsedSendCommand {
	message: string;
	pid?: number;
}

export function handleControlCommand(args: string[], dependencies: ControlCommandDependencies): boolean {
	if (args[0] !== "control") return false;

	const stdout = dependencies.stdout ?? ((text) => process.stdout.write(text));
	const stderr = dependencies.stderr ?? ((text) => process.stderr.write(text));
	const signalProcess = dependencies.signalProcess ?? ((pid, signal) => process.kill(pid, signal));

	const subcommand = args[1];
	if (subcommand === "send") {
		const parsed = parseSendCommand(args.slice(2));
		if (!parsed) {
			printControlHelp(stderr);
			process.exitCode = 1;
			return true;
		}

		const id = enqueueIncomingMessage(getControlDbPath(dependencies.agentDir), parsed.message);
		stdout(`queued ${id}\n`);
		if (parsed.pid !== undefined) {
			signalProcess(parsed.pid, "SIGHUP");
			stdout(`signaled ${parsed.pid}\n`);
		}
		return true;
	}

	if (subcommand === "restart") {
		const sessionId = parseRestartCommand(args.slice(2));
		if (!sessionId) {
			printControlHelp(stderr);
			process.exitCode = 1;
			return true;
		}
		const health = readSessionHealth(getControlDbPath(dependencies.agentDir), sessionId);
		if (!health?.pid || health.checkStatus !== "ok") {
			stderr(`Session ${sessionId} is not running.\n`);
			process.exitCode = 1;
			return true;
		}
		try {
			signalProcess(health.pid, "SIGHUP");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			stderr(`Could not restart session ${sessionId}: ${message}\n`);
			process.exitCode = 1;
			return true;
		}
		stdout(`signaled session ${sessionId} (pid ${health.pid})\n`);
		return true;
	}

	if (subcommand === "last") {
		const lastMessage = readLastMessage(getControlDbPath(dependencies.agentDir));
		if (lastMessage) {
			stdout(`${lastMessage.content}\n`);
		}
		return true;
	}

	if (subcommand === "path") {
		stdout(`${getControlDbPath(dependencies.agentDir)}\n`);
		return true;
	}

	printControlHelp(subcommand === "--help" || subcommand === "-h" ? stdout : stderr);
	process.exitCode = subcommand === "--help" || subcommand === "-h" ? 0 : 1;
	return true;
}

function parseSendCommand(args: string[]): ParsedSendCommand | undefined {
	let pid: number | undefined;
	const messageParts: string[] = [];

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--pid") {
			const rawPid = args[++index];
			const parsedPid = rawPid ? Number(rawPid) : NaN;
			if (!Number.isInteger(parsedPid) || parsedPid <= 0) {
				return undefined;
			}
			pid = parsedPid;
			continue;
		}
		messageParts.push(arg);
	}

	const message = messageParts.join(" ").trim();
	if (!message) return undefined;
	return { message, pid };
}

function parseRestartCommand(args: string[]): string | undefined {
	if (args.length !== 2 || args[0] !== "--session-id") return undefined;
	return args[1]?.trim() || undefined;
}

function printControlHelp(write: (text: string) => void): void {
	write(`Usage:
  pi control send [--pid <pid>] <message>
  pi control restart --session-id <session-id>
  pi control last
  pi control path
`);
}
