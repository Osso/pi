import type { AgentSession } from "../../../src/core/agent-session.ts";
import type { SessionShutdownEvent } from "../../../src/core/extensions/types.ts";
import type { SessionManager } from "../../../src/core/session-manager.ts";
import type { ChildAgentSession } from "./runtime.ts";

type LiveChildAgentSession = ChildAgentSession &
	Pick<
		AgentSession,
		"model" | "thinkingLevel" | "setModel" | "setThinkingLevel" | "modelRegistry" | "scopedModels" | "cycleModel"
	>;

export interface UnboundChildAgentSession extends LiveChildAgentSession {
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

export function bindProductionChildSession(session: UnboundChildAgentSession): LiveChildAgentSession {
	return {
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
		prompt: (text) => session.prompt(text),
		get transcript() {
			return session.transcript;
		},
	};
}
