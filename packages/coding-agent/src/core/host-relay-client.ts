import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { runHostRelay } from "./host-relay.ts";

export interface RelaySettings {
	peer: string;
	remoteCommand?: string;
}

async function connectRelay(controlDbPath: string, settings: RelaySettings, signal: AbortSignal): Promise<void> {
	const child = spawn(
		"ssh",
		[
			"-o",
			"BatchMode=yes",
			"-o",
			"ServerAliveInterval=15",
			settings.peer,
			settings.remoteCommand ?? "pi relay serve",
		],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr = (stderr + chunk.toString()).slice(-4096);
	});
	const closed = new Promise<Error | undefined>((resolve) => {
		child.once("error", (error) => resolve(error));
		child.once("close", (code, exitSignal) => {
			resolve(
				signal.aborted || code === 0 ? undefined : new Error(`ssh exited ${code ?? exitSignal}: ${stderr.trim()}`),
			);
		});
	});
	const terminate = () => {
		child.kill("SIGTERM");
	};
	signal.addEventListener("abort", terminate, { once: true });
	try {
		await runHostRelay({ controlDbPath, input: child.stdout, output: child.stdin, signal });
		const error = await closed;
		if (error) throw error;
	} finally {
		signal.removeEventListener("abort", terminate);
		if (child.exitCode === null && child.signalCode === null) {
			terminate();
			const killTimer = setTimeout(() => {
				child.kill("SIGKILL");
			}, 1000);
			try {
				await closed;
			} finally {
				clearTimeout(killTimer);
			}
		}
	}
}

/** Failure is confined to this connection; authoritative local queues stay untouched. */
export async function runSshRelayClient(
	controlDbPath: string,
	settings: RelaySettings,
	signal: AbortSignal,
): Promise<void> {
	let failures = 0;
	while (!signal.aborted) {
		const started = Date.now();
		try {
			if (!settings.peer?.trim() || settings.peer.startsWith("-"))
				throw new Error("relay.peer must be a non-empty SSH alias, not an option");
			await connectRelay(controlDbPath, settings, signal);
			if (!signal.aborted) console.error(`[relay:${settings.peer}] connection closed; reconnecting`);
		} catch (error) {
			if (!signal.aborted)
				console.error(`[relay:${settings.peer}] ${error instanceof Error ? error.message : String(error)}`);
		}
		if (signal.aborted) break;
		if (Date.now() - started >= 30_000) failures = 0;
		const backoffMs = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
		try {
			await delay(Math.round(backoffMs * (0.5 + Math.random() * 0.5)), undefined, { signal });
		} catch (error) {
			if (!signal.aborted) throw error;
		}
	}
}
