import { writeFileSync } from "node:fs";
import { fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { FileEntry, SessionMessageEntry } from "../../src/core/session-manager.ts";

/** A retained user message whose parent and an inactive branch are outside the loaded slice. */
export function writeCompactedSessionFixture(filePath: string, cwd: string, model: Model<string>): void {
	const timestamp = "2026-11-14T00:00:00.000Z";
	const user = (id: string, parentId: string | null, text: string): SessionMessageEntry => ({
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role: "user", content: text, timestamp: Date.parse(timestamp) },
	});
	const assistant = (id: string, parentId: string, text: string): SessionMessageEntry => ({
		type: "message",
		id,
		parentId,
		timestamp,
		message: { ...fauxAssistantMessage(text), provider: model.provider, model: model.id, api: model.api },
	});
	const entries: FileEntry[] = [
		{ type: "session", version: 3, id: "compacted-session", timestamp, cwd },
		user("old-user", null, "Original request"),
		assistant("old-assistant", "old-user", "Original reply"),
		user("inactive-user", "old-assistant", "Inactive request"),
		assistant("inactive-assistant", "inactive-user", "Inactive reply"),
		{ type: "label", id: "old-label", parentId: "old-assistant", timestamp, targetId: "old-user", label: "Original" },
		user("kept-user", "old-label", "Retained request"),
		assistant("kept-assistant", "kept-user", "Retained reply"),
		{
			type: "compaction",
			id: "compaction",
			parentId: "kept-assistant",
			timestamp,
			summary: "Earlier conversation",
			firstKeptEntryId: "kept-user",
			tokensBefore: 1000,
		},
		user("after-user", "compaction", "Later request"),
		assistant("after-assistant", "after-user", "Later reply"),
	];
	writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}
