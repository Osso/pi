import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { serverHostId } from "../../../src/cli/server-wire.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import { isActiveLifecycle, type MultiAgentStore } from "../../../src/core/multi-agent-store.ts";
import type { AttachedSessionFactory, ChildAgentSession, ChildAgentSessionFactory } from "./contracts.ts";
import { HubConnection } from "./remote-host.ts";

type Frame = Record<string, unknown>;

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
