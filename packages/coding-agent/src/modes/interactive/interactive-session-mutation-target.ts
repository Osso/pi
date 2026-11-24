import type { AgentSession } from "../../core/agent-session.ts";
import type { SessionMutationTarget } from "../../core/extensions/types.ts";

/** The viewed live session that interactive model and thinking controls mutate. */
export type InteractiveSessionMutationTarget = SessionMutationTarget &
	Pick<AgentSession, "cycleModel" | "cycleThinkingLevel" | "modelRegistry" | "scopedModels">;

export function isInteractiveSessionMutationTarget(
	target: SessionMutationTarget,
): target is InteractiveSessionMutationTarget {
	return (
		"cycleModel" in target &&
		typeof target.cycleModel === "function" &&
		"cycleThinkingLevel" in target &&
		typeof target.cycleThinkingLevel === "function" &&
		"modelRegistry" in target &&
		target.modelRegistry !== undefined &&
		"scopedModels" in target &&
		Array.isArray(target.scopedModels)
	);
}
