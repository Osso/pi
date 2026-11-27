import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import type { Readable, Writable } from "node:stream";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { defaultHubCommand, readFrames, serverHostId, socketPath, writeFrame } from "../../../src/cli/server-wire.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import { isActiveLifecycle, type MultiAgentStore } from "../../../src/core/multi-agent-store.ts";
import type { AttachedSessionFactory, ChildAgentSession, ChildAgentSessionFactory } from "./contracts.ts";

type Frame = Record<string, unknown>;
type PendingRequest = { resolve: (data: Frame) => void; reject: (error: Error) => void };

/** One pi server protocol connection to the hub, which routes frames by hostId to the other machines. */
class HubConnection {
	private readonly output: Writable;
	private readonly destroy: () => void;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly frameListeners = new Set<(frame: Frame) => void>();
	private readonly closeListeners = new Set<(error: Error) => void>();
	private nextId = 0;
	closed: Error | undefined;

	constructor(input: Readable, output: Writable, destroy: () => void) {
		this.output = output;
		this.destroy = destroy;
		readFrames(
			input,
			(frame) => this.accept(frame),
			() => this.fail(new Error("Invalid frame from the pi server hub")),
		);
		input.once("close", () => this.fail(new Error("Connection to the pi server hub closed")));
		input.once("error", (error) => this.fail(new Error(`pi server hub connection failed: ${error.message}`)));
	}

	/** The local socket on the hub; elsewhere the spoke link command (`server.hubCommand`), whose hub end is a stdio connector. */
	static async open(ctx: ExtensionContext): Promise<HubConnection> {
		const server = ctx.settingsManager?.getMergedSettings().server;
		if (!server?.hub) throw new Error("spawn_agent host requires server.hub in settings");
		let connection: HubConnection;
		if (server.hub === serverHostId()) {
			const socket = createConnection(socketPath());
			connection = new HubConnection(socket, socket, () => socket.destroy());
		} else {
			const [program, ...args] = server.hubCommand ?? defaultHubCommand(server.hub);
			if (!program) throw new Error("server.hubCommand is empty");
			const child = spawn(program, args, { stdio: ["pipe", "pipe", "ignore"] });
			connection = new HubConnection(child.stdout, child.stdin, () => child.kill("SIGTERM"));
		}
		try {
			await connection.request("hello", { version: 1 });
		} catch (error) {
			connection.close();
			throw error;
		}
		return connection;
	}

	request(type: string, fields: Frame): Promise<Frame> {
		if (this.closed) return Promise.reject(this.closed);
		const id = `remote-child-${++this.nextId}`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			writeFrame(this.output, { ...fields, type, id });
		});
	}

	onFrame(listener: (frame: Frame) => void): void {
		this.frameListeners.add(listener);
	}

	onClose(listener: (error: Error) => void): void {
		if (this.closed) listener(this.closed);
		else this.closeListeners.add(listener);
	}

	close(): void {
		this.fail(new Error("Connection to the pi server hub closed"));
		this.destroy();
	}

	private accept(frame: Frame): void {
		if (frame.type !== "response") {
			for (const listener of this.frameListeners) listener(frame);
			return;
		}
		const pending = this.pending.get(String(frame.id));
		if (!pending) return;
		this.pending.delete(String(frame.id));
		const error = frame.error as { code?: string; message?: string } | undefined;
		if (frame.success === true) pending.resolve((frame.data ?? {}) as Frame);
		else pending.reject(new Error(`${String(frame.command)} failed: ${error?.code}: ${error?.message}`));
	}

	private fail(error: Error): void {
		if (this.closed) return;
		this.closed = error;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
		for (const listener of this.closeListeners) listener(error);
		this.closeListeners.clear();
	}
}

/**
 * A child that runs as a pi server worker on another machine. The worker outlives this process: a parent restart
 * reattaches to it, a cancel aborts its run, and the end of the child stops the worker.
 */
class RemoteChildSession implements ChildAgentSession {
	private readonly hub: HubConnection;
	private readonly store: MultiAgentStore;
	private readonly agentId: string;
	private readonly host: string;
	private readonly sessionId: string;
	private readonly runtimeInstanceId: string;
	private readonly settledListeners = new Set<() => void>();
	private settledRuns = 0;
	messages: AgentMessage[] = [];
	readonly transcript: { host: string; sessionId: string };
	/** Undefined when reattached after a parent restart: its run was already prompted, so prompt() waits for that run. */
	private readonly parentAddress: string | undefined;

	constructor(input: {
		agentId: string;
		host: string;
		hub: HubConnection;
		parentAddress: string | undefined;
		runtimeInstanceId: string;
		sessionId: string;
		store: MultiAgentStore;
	}) {
		this.agentId = input.agentId;
		this.host = input.host;
		this.hub = input.hub;
		this.parentAddress = input.parentAddress;
		this.runtimeInstanceId = input.runtimeInstanceId;
		this.sessionId = input.sessionId;
		this.store = input.store;
		this.transcript = { host: input.host, sessionId: input.sessionId };
		input.hub.onFrame((frame) => {
			const event = frame.event as Frame | undefined;
			if (frame.type !== "session_event" || frame.sessionId !== this.sessionId || event?.type !== "agent_settled")
				return;
			this.settledRuns += 1;
			for (const listener of this.settledListeners) listener();
		});
	}

	async prompt(text: string): Promise<void> {
		if (this.parentAddress === undefined) {
			await this.waitForIdle();
		} else {
			const seen = this.settledRuns;
			await this.rpc({ type: "prompt", message: `${text}\n\n${this.parentAddress}` });
			await this.waitForSettledRun(seen);
		}
		const messages = await this.rpc({ type: "get_messages" });
		this.messages = (messages.data as { messages: AgentMessage[] }).messages;
	}

	/** A parent restart also aborts its children; the remote run continues and is reattached, so only a cancel aborts it. */
	abort(): void {
		if (this.store.getAgent(this.agentId)?.lifecycle !== "cancelling") return;
		this.rpc({ type: "abort" }).catch((error: unknown) =>
			console.error(`Failed to abort remote child ${this.agentId} on ${this.host}:`, error),
		);
	}

	async dispose(): Promise<void> {
		const agent = this.store.getAgent(this.agentId);
		// A child that is still active here was interrupted by a parent restart; the restarted parent reattaches it.
		const finished = !agent || !isActiveLifecycle(agent.lifecycle);
		try {
			if (finished) await this.stopWorker();
		} catch (error) {
			console.error(
				`Failed to stop remote child ${this.agentId} (session ${this.sessionId} on ${this.host}):`,
				error,
			);
		} finally {
			this.hub.close();
		}
	}

	private async stopWorker(): Promise<void> {
		await this.hub.request("stop_session", {
			hostId: this.host,
			sessionId: this.sessionId,
			runtimeInstanceId: this.runtimeInstanceId,
		});
	}

	private async rpc(command: Frame): Promise<Frame> {
		const data = await this.hub.request("session_rpc", {
			hostId: this.host,
			sessionId: this.sessionId,
			runtimeInstanceId: this.runtimeInstanceId,
			command,
		});
		const response = data.response as Frame;
		if (response.success !== true)
			throw new Error(`Remote child ${String(command.type)} failed on ${this.host}: ${String(response.error)}`);
		return response;
	}

	private async waitForIdle(): Promise<void> {
		for (;;) {
			const seen = this.settledRuns;
			const state = await this.rpc({ type: "get_state" });
			if ((state.data as { isStreaming?: boolean }).isStreaming !== true) return;
			await this.waitForSettledRun(seen);
		}
	}

	private waitForSettledRun(seen: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const check = () => {
				if (this.settledRuns <= seen) return;
				this.settledListeners.delete(check);
				resolve();
			};
			this.settledListeners.add(check);
			this.hub.onClose(reject);
			check();
		});
	}
}

async function attachRemoteChild(
	store: MultiAgentStore,
	agentId: string,
	host: string,
	hub: HubConnection,
	sessionId: string,
	parentAddress: string | undefined,
): Promise<RemoteChildSession> {
	const attached = await hub.request("attach_session", { hostId: host, sessionId, mode: "control" });
	const runtimeInstanceId = String(attached.runtimeInstanceId);
	return new RemoteChildSession({ agentId, host, hub, parentAddress, runtimeInstanceId, sessionId, store });
}

/** Tells the child where its parent is, so it can message the parent over the host relay. */
function describeParentAddress(ctx: ExtensionContext): string {
	const sessionId = ctx.sessionManager.getSessionId();
	const host = serverHostId();
	return `[You are a sub-agent of session ${sessionId} on host ${host}. Your final reply is returned to it. To message it before then, use send_agent_message with toAgentId "main", toSessionId "${sessionId}", toHost "${host}".]`;
}

/** Starts the child as a pi server worker on `host` in the agent's cwd, through the hub. */
export function createRemoteChildSessionFactory(store: MultiAgentStore, host: string): ChildAgentSessionFactory {
	return async ({ agent, ctx }) => {
		const hub = await HubConnection.open(ctx);
		try {
			const started = await hub.request("start_session", { hostId: host, cwd: agent.cwd, name: agent.displayName });
			const sessionId = String((started.session as Frame).sessionId);
			return await attachRemoteChild(store, agent.id, host, hub, sessionId, describeParentAddress(ctx));
		} catch (error) {
			hub.close();
			throw error;
		}
	};
}

/** Reattaches a remote child after a parent restart; the recovery prompt is not sent, the child's run continues. */
export function createRemoteAttachedSessionFactory(store: MultiAgentStore): AttachedSessionFactory {
	return async ({ agent, ctx }) => {
		const transcript = agent.transcript;
		if (!transcript?.host) throw new Error(`Agent ${agent.id} is not a remote child`);
		const hub = await HubConnection.open(ctx);
		try {
			return await attachRemoteChild(store, agent.id, transcript.host, hub, transcript.sessionId, undefined);
		} catch (error) {
			hub.close();
			throw error;
		}
	};
}
