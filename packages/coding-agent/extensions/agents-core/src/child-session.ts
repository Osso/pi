import type { AgentSession, AgentSessionEvent } from "../../../src/core/agent-session.ts";
import type { SessionShutdownEvent } from "../../../src/core/extensions/types.ts";
import type { SessionManager } from "../../../src/core/session-manager.ts";
import type { ChildAgentSession } from "./runtime.ts";

type LiveChildAgentSession = ChildAgentSession &
	Pick<
		AgentSession,
		"model" | "thinkingLevel" | "setModel" | "setThinkingLevel" | "modelRegistry" | "scopedModels" | "cycleModel"
	>;

export interface UnboundChildAgentSession extends Omit<LiveChildAgentSession, "prompt"> {
	prompt: AgentSession["prompt"];
	readonly agent: Pick<AgentSession["agent"], "waitForIdle">;
	readonly sessionManager: Pick<SessionManager, "getBranch">;
	extensionRunner: { emit(event: SessionShutdownEvent): Promise<unknown> };
	bindExtensions(bindings: Record<string, never>): Promise<void>;
}

async function shutdownChildSession(session: UnboundChildAgentSession): Promise<void> {
	try {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	} finally {
		await session.dispose?.();
	}
}

/** Tool calls that ended but are not in the transcript yet; a parallel batch records its results only after its slowest call. */
function trackFinishedToolCalls(
	session: UnboundChildAgentSession,
): ReadonlyMap<string, Extract<AgentSessionEvent, { type: "tool_execution_end" }>> {
	const finished = new Map<string, Extract<AgentSessionEvent, { type: "tool_execution_end" }>>();
	session.subscribe?.((event) => {
		if (event.type === "tool_execution_end") finished.set(event.toolCallId, event);
		if (event.type === "message_end" && event.message.role === "toolResult") finished.delete(event.message.toolCallId);
	});
	return finished;
}

/**
 * The dispatcher reads the child's result when this resolves, so the prompt must be answered first.
 * The runtime mailbox can start a turn first (restart recovery delivering pending steering): queue the
 * prompt behind that turn instead of failing the child, then wait until the session is idle.
 */
async function promptChildTurn(session: UnboundChildAgentSession, text: string): Promise<void> {
	await session.prompt(text, { streamingBehavior: "followUp" });
	await session.agent.waitForIdle();
}

export function bindProductionChildSession(session: UnboundChildAgentSession): LiveChildAgentSession {
	return {
		finishedToolCalls: trackFinishedToolCalls(session),
		abort: () => session.abort?.(),
		dispose: () => shutdownChildSession(session),
		drainRuntimeCoordination: session.drainRuntimeCoordination?.bind(session),
		get messages() {
			return session.sessionManager
				.getBranch()
				.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		},
		get model() {
			return session.model;
		},
		get thinkingLevel() {
			return session.thinkingLevel;
		},
		get modelRegistry() {
			return session.modelRegistry;
		},
		get scopedModels() {
			return session.scopedModels;
		},
		setModel: session.setModel.bind(session),
		setThinkingLevel: session.setThinkingLevel.bind(session),
		cycleModel: session.cycleModel.bind(session),
		prompt: (text) => promptChildTurn(session, text),
		subscribe: session.subscribe?.bind(session),
		get transcript() {
			return session.transcript;
		},
	};
}
