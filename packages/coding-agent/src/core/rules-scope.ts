import type { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";

/** Which `rules/` subdirectories a runtime loads after the shared top-level rules. */
export type RulesScope = "shared" | "main" | "sub-agent" | "supervisor";

export const RULES_SCOPE_DIRECTORIES: Record<RulesScope, readonly string[]> = {
	shared: [],
	main: ["main"],
	"sub-agent": ["sub-agent"],
	supervisor: ["main", "supervisor"],
};

/** A main session loads main rules; the configured Supervisor session also loads supervisor rules. */
export function mainSessionRulesScope(settingsManager: SettingsManager, sessionManager: SessionManager): RulesScope {
	const supervisorSessionId = settingsManager.getMergedSettings().supervisor?.sessionId;
	return supervisorSessionId !== undefined && supervisorSessionId === sessionManager.getSessionId()
		? "supervisor"
		: "main";
}
