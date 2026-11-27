import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { HeadlessPi } from "./headless-pi.ts";

export type Frame = Record<string, unknown>;

export const FOREIGN_SUPERVISOR_HOST = `${hostname()}-remote-supervisor`;

export class ServerClient {
	private readonly lines: ReturnType<typeof createInterface>;
	readonly socket: Socket;
	private readonly pending = new Map<string, (frame: Frame) => void>();
	private readonly events: Frame[] = [];
	private requestId = 0;

	constructor(socket: Socket) {
		this.socket = socket;
		this.lines = createInterface({ input: socket, crlfDelay: Infinity });
		this.lines.on("line", (line) => {
			const frame = JSON.parse(line) as Frame;
			if (frame.type === "response" && typeof frame.id === "string") {
				this.pending.get(frame.id)?.(frame);
				this.pending.delete(frame.id);
			} else this.events.push(frame);
		});
	}

	static async connect(path: string): Promise<ServerClient> {
		const socket = createConnection(path);
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		return new ServerClient(socket);
	}

	request(type: string, fields: Frame = {}): Promise<Frame> {
		const id = `test-${++this.requestId}`;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for ${type}`));
			}, 30_000);
			this.pending.set(id, (frame) => {
				clearTimeout(timeout);
				resolve(frame);
			});
			this.socket.write(`${JSON.stringify({ id, type, ...fields })}\n`);
		});
	}

	close(): void {
		this.lines.close();
		this.socket.destroy();
	}

	async waitForEvent(predicate: (event: Frame) => boolean): Promise<Frame> {
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const event = this.events.find(predicate);
			if (event) return event;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error("Timed out waiting for server event");
	}
}

export async function startDaemon(
	agent: HeadlessPi,
	supervisorHost: string | null = FOREIGN_SUPERVISOR_HOST,
	options: { hostId?: string; hub?: string; hubCommand?: string[]; runtimeDir?: string } = {},
): Promise<{ daemon: ChildProcess; client: ServerClient; runtimeDir: string }> {
	const runtimeDir = options.runtimeDir ?? join(agent.paths.tempDir, "runtime");
	mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
	const socketPath = join(runtimeDir, "pi", "server.sock");
	const cliPath = join(import.meta.dirname, "../../src/cli.ts");
	const preloadPath = join(import.meta.dirname, "fixtures/headless-pi-provider-preload.ts");
	const settings = SettingsManager.create(agent.paths.workspaceDir, agent.paths.agentDir, { projectTrusted: true });
	settings.setDefaultModelAndProvider("headless-faux", "headless-faux-1");
	const settingsPath = join(agent.paths.agentDir, "settings.json");
	const storedSettings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
	if (supervisorHost !== null) storedSettings.supervisor = { host: supervisorHost, sessionId: "remote-supervisor" };
	else delete storedSettings.supervisor;
	if (options.hub)
		storedSettings.server = { hub: options.hub, ...(options.hubCommand ? { hubCommand: options.hubCommand } : {}) };
	else delete storedSettings.server;
	writeFileSync(settingsPath, JSON.stringify(storedSettings));
	const { daemon, stderr } = spawnDaemon(agent, runtimeDir, preloadPath, cliPath, options.hostId);
	// Connect, not just check the file: a crashed server's stale socket file exists before the new server binds.
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (daemon.exitCode !== null) throw new Error(`pi server exited: ${stderr()}`);
		if (existsSync(socketPath)) {
			try {
				return { daemon, client: await ServerClient.connect(socketPath), runtimeDir };
			} catch {
				// Not listening yet.
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`pi server did not accept connections: ${stderr()}`);
}

export function spawnDaemon(
	agent: HeadlessPi,
	runtimeDir: string,
	preloadPath: string,
	cliPath: string,
	hostId?: string,
): { daemon: ChildProcess; stderr: () => string } {
	const daemon = spawn(
		process.execPath,
		[
			"--experimental-strip-types",
			"--import",
			pathToFileURL(preloadPath).href,
			...process.execArgv,
			cliPath,
			"server",
		],
		{
			cwd: agent.paths.workspaceDir,
			env: {
				...process.env,
				XDG_RUNTIME_DIR: runtimeDir,
				PI_CODING_AGENT_DIR: agent.paths.agentDir,
				PI_CODING_AGENT_STATE_DIR: agent.paths.agentDir,
				PI_CODING_AGENT_SESSION_DIR: agent.paths.sessionDir,
				PI_HEADLESS_PROVIDER_SOCKET: join(agent.paths.tempDir, "provider.sock"),
				...(hostId ? { PI_SERVER_HOST_ID: hostId } : {}),
			},
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	let stderr = "";
	daemon.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	return { daemon, stderr: () => stderr };
}

export function stopDaemon(daemon: ChildProcess, runtimeDir: string): Promise<void> {
	if (daemon.exitCode !== null) {
		rmSync(runtimeDir, { recursive: true, force: true });
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		daemon.once("exit", () => {
			rmSync(runtimeDir, { recursive: true, force: true });
			resolve();
		});
		daemon.kill("SIGTERM");
	});
}

/** A spoke link to the hub that runs the local `pi server --link` against the hub's runtime dir instead of SSH. */
export function localHubCommand(hubRuntimeDir: string): string[] {
	return [
		"env",
		`XDG_RUNTIME_DIR=${hubRuntimeDir}`,
		process.execPath,
		"--experimental-strip-types",
		...process.execArgv,
		join(import.meta.dirname, "../../src/cli.ts"),
		"server",
		"--link",
	];
}
