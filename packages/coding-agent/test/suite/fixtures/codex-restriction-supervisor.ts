import { fork } from "node:child_process";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import {
	getControlDbPath,
	type SupervisorRequest,
	type SupervisorResponse,
} from "../../../src/core/session-control-db.ts";
import type { HeadlessPi } from "../headless-pi.ts";

export interface ControlledRestrictionSupervisor {
	pid: number;
	claim(): Promise<SupervisorRequest>;
	answer(request: SupervisorRequest, response: SupervisorResponse): Promise<SupervisorRequest>;
	ping(): Promise<{ pid: number; ready: boolean }>;
	close(): Promise<void>;
}

interface Reply {
	id: number;
	value?: unknown;
	error?: string;
}

export async function startControlledRestrictionSupervisor(
	agent: HeadlessPi,
): Promise<ControlledRestrictionSupervisor> {
	const controlDbPath = getControlDbPath(agent.paths.agentDir);
	// Transfer the disposable probe pathname to a real resident child. The original
	// fixture still owns its now-unlinked server and cleans it up at disposal.
	unlinkSync(`${controlDbPath}.supervisor-console.sock`);
	const child = fork(join(import.meta.dirname, "codex-restriction-supervisor-child.ts"), [controlDbPath], {
		execArgv: ["--experimental-strip-types"],
		cwd: agent.paths.workspaceDir,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agent.paths.agentDir,
			PI_CODING_AGENT_STATE_DIR: agent.paths.agentDir,
			PI_CODING_AGENT_SESSION_DIR: agent.paths.sessionDir,
		},
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	let stderr = "";
	child.stderr?.on("data", (chunk) => {
		stderr += String(chunk);
	});
	const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	let nextId = 1;
	child.on("message", (reply: Reply) => {
		const waiter = pending.get(reply.id);
		if (!waiter) return;
		pending.delete(reply.id);
		if (reply.error) waiter.reject(new Error(reply.error));
		else waiter.resolve(reply.value);
	});
	const exited = new Promise<void>((resolve) => {
		child.once("exit", () => {
			for (const waiter of pending.values()) waiter.reject(new Error(`Controlled Supervisor exited: ${stderr}`));
			pending.clear();
			resolve();
		});
	});
	child.on("error", (error) => {
		for (const waiter of pending.values()) waiter.reject(error);
		pending.clear();
	});
	const send = <T>(kind: string, fields: Record<string, unknown> = {}): Promise<T> => {
		const id = nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`Controlled Supervisor ${kind} timeout: ${stderr}`));
			}, 12_000);
			pending.set(id, {
				resolve(value) {
					clearTimeout(timer);
					resolve(value as T);
				},
				reject(error) {
					clearTimeout(timer);
					reject(error);
				},
			});
			child.send({ id, kind, ...fields }, (error) => {
				if (error) pending.get(id)?.reject(error);
			});
		});
	};
	const close = async (): Promise<void> => {
		if (child.exitCode !== null || child.signalCode !== null) return exited;
		const timeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
		try {
			await send("close");
			await exited;
		} finally {
			clearTimeout(timeout);
		}
	};
	try {
		const identity = await send<{ pid: number; ready: boolean }>("ping");
		return {
			pid: identity.pid,
			claim: () => send<SupervisorRequest>("claim"),
			answer: (request, response) => send<SupervisorRequest>("answer", { request, response }),
			ping: () => send<{ pid: number; ready: boolean }>("ping"),
			close,
		};
	} catch (error) {
		child.kill("SIGKILL");
		await exited;
		throw error;
	}
}
