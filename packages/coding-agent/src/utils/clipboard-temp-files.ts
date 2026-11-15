import { unlinkSync } from "node:fs";
import type { AgentSession } from "../core/agent-session.ts";

type SessionRunState = Pick<AgentSession, "isStreaming" | "subscribe">;

export type ClipboardTempFileTracker = {
	track(filePath: string): void;
	/** Deletes tracked files referenced in submitted text once the session has finished answering it. */
	cleanupReferencedIn(text: string, session: SessionRunState): void;
	cleanupAll(): void;
};

function removeFile(filePath: string): void {
	try {
		unlinkSync(filePath);
	} catch {
		// Temp cleanup is best-effort: the file may already be gone.
	}
}

export function createClipboardTempFileTracker(): ClipboardTempFileTracker {
	const trackedFiles = new Set<string>();

	const removeReferenced = (text: string): void => {
		for (const filePath of [...trackedFiles]) {
			if (!text.includes(filePath)) {
				continue;
			}
			removeFile(filePath);
			trackedFiles.delete(filePath);
		}
	};

	return {
		track(filePath: string): void {
			trackedFiles.add(filePath);
		},

		cleanupReferencedIn(text: string, session: SessionRunState): void {
			if (!session.isStreaming) {
				removeReferenced(text);
				return;
			}
			// The text was queued into a running turn; the model reads the file during that run.
			const unsubscribe = session.subscribe((event) => {
				if (event.type !== "agent_settled") return;
				unsubscribe();
				removeReferenced(text);
			});
		},

		cleanupAll(): void {
			for (const filePath of [...trackedFiles]) {
				removeFile(filePath);
				trackedFiles.delete(filePath);
			}
		},
	};
}
