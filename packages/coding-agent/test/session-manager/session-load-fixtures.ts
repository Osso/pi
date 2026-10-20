import type { FileEntry, SessionEntry, SessionManager } from "../../src/core/session-manager.ts";

const timestamp = "2026-10-20T00:00:00.000Z";

export function sessionLoadFixture(compactions: number, withCwd: boolean): FileEntry[] {
	const entries: FileEntry[] = [
		{ type: "session", version: 3, id: "load-parity", timestamp, cwd: "/repo", parentSession: "/parent.jsonl" },
	];
	let parentId: string | null = null;
	function add(entry: Omit<SessionEntry, "id" | "parentId" | "timestamp"> & Record<string, unknown>): string {
		const id = `entry-${entries.length}`;
		entries.push({ ...entry, id, parentId, timestamp } as SessionEntry);
		parentId = id;
		return id;
	}
	function message(content: string): string {
		return add({ type: "message", message: { role: "user", content, timestamp: 1 } });
	}
	add({ type: "model_change", provider: "openai", modelId: "old-model" });
	add({ type: "thinking_level_change", thinkingLevel: "high" });
	const root = message("needle historical café 🧭");
	if (withCwd)
		add({
			type: "custom_message",
			customType: "cwd_changed",
			content: "cwd changed",
			details: { cwd: "/relocated" },
			display: true,
		});
	const firstKept = message("needle first retained");
	if (compactions >= 1)
		add({ type: "compaction", summary: "first summary", firstKeptEntryId: firstKept, tokensBefore: 1000 });
	const middle = message("needle middle");
	parentId = root;
	message("needle abandoned branch");
	add({
		type: "custom_message",
		customType: "cwd_changed",
		content: "wrong cwd",
		details: { cwd: "/abandoned" },
		display: true,
	});
	parentId = middle;
	const secondKept = message("needle second retained");
	if (compactions >= 2)
		add({ type: "compaction", summary: "second summary", firstKeptEntryId: secondKept, tokensBefore: 2000 });
	add({ type: "model_change", provider: "openai", modelId: "current-model" });
	add({ type: "thinking_level_change", thinkingLevel: "medium" });
	add({ type: "custom", customType: "extension-state", data: { active: true } });
	add({ type: "label", targetId: secondKept, label: "retained label" });
	message("needle current");
	return entries;
}

export function loadedSessionState(manager: SessionManager) {
	return {
		header: manager.getHeader(),
		entries: manager.getEntries(),
		branch: manager.getBranch(),
		contextEntries: manager.buildContextEntries(),
		context: manager.buildSessionContext(),
		tree: manager.getTree(),
		leaf: manager.getLeafEntry(),
		cwd: manager.getCwd(),
		name: manager.getSessionName(),
		hasName: manager.hasSessionNameState(),
	};
}
