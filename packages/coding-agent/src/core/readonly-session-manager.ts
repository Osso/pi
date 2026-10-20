import type { ReadonlySessionManager, SessionTreeNode } from "./session-manager.ts";

function readIsolatedTree(session: ReadonlySessionManager): SessionTreeNode[] {
	// SessionManager creates fresh nodes, but their entries still alias storage.
	// Clone entries iteratively so tree depth does not exhaust the call stack.
	const roots = session.getTree();
	const pending = [...roots];
	while (pending.length > 0) {
		const node = pending.pop();
		if (!node) break;
		node.entry = structuredClone(node.entry);
		pending.push(...node.children);
	}
	return roots;
}

/**
 * Extension-facing session access. Each object-valued read returns a mutable,
 * isolated snapshot; core readers keep using SessionManager without cloning.
 */
export function createReadonlySessionManager(session: ReadonlySessionManager): ReadonlySessionManager {
	return {
		getCwd: () => session.getCwd(),
		getSessionDir: () => session.getSessionDir(),
		getSessionId: () => session.getSessionId(),
		getSessionFile: () => session.getSessionFile(),
		getLeafId: () => session.getLeafId(),
		getLeafEntry: () => structuredClone(session.getLeafEntry()),
		getEntry: (id) => structuredClone(session.getEntry(id)),
		getLabel: (id) => session.getLabel(id),
		getBranch: (fromId) => structuredClone(session.getBranch(fromId)),
		buildContextEntries: () => structuredClone(session.buildContextEntries()),
		getHeader: () => structuredClone(session.getHeader()),
		getEntries: () => structuredClone(session.getEntries()),
		getTree: () => readIsolatedTree(session),
		getSessionName: () => session.getSessionName(),
		hasSessionNameState: () => session.hasSessionNameState(),
		getSessionGoalJson: () => session.getSessionGoalJson(),
		getSessionGoalJsonForSession: (sessionFile) => session.getSessionGoalJsonForSession(sessionFile),
		setSessionGoalJson: (goalJson) => session.setSessionGoalJson(goalJson),
		clearSessionGoalJson: () => session.clearSessionGoalJson(),
		isSubagentSession: () => session.isSubagentSession(),
		getSubagentName: () => session.getSubagentName(),
	};
}
