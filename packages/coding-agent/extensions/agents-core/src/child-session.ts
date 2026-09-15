import type { SessionShutdownEvent } from "../../../src/core/extensions/types.ts";
import type { SessionManager } from "../../../src/core/session-manager.ts";
import type { ChildAgentSession } from "./runtime.ts";

export interface UnboundChildAgentSession extends ChildAgentSession {
	readonly sessionManager: Pick<SessionManager, "getBranch">;
	extensionRunner: { emit(event: SessionShutdownEvent): Promise<unknown> };
	bindExtensions(bindings: Record<string, never>): Promise<void>;
}

export function bindProductionChildSession(session: UnboundChildAgentSession): ChildAgentSession {
	return {
		abort: () => session.abort?.(),
		async dispose() {
			try {
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			} finally {
				await session.dispose?.();
			}
		},
		drainRuntimeCoordination: session.drainRuntimeCoordination?.bind(session),
		get messages() {
			return session.sessionManager.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		},
		prompt: (text) => session.prompt(text),
		get transcript() {
			return session.transcript;
		},
	};
}
