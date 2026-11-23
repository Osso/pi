import { existsSync } from "node:fs";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionShutdownEvent,
} from "../../../src/core/extensions/types.ts";
import { archivePersistedSession } from "../../../src/core/session-archive-storage.ts";
import { readSessionMetadata, unarchiveSession } from "../../../src/core/session-control-db.ts";
import { deleteSessionTree } from "../../../src/core/session-delete.ts";
import {
	CLOSE_ALL_AGENTS_EVENT,
	type CloseAllAgentsRequest,
	runningChildAgents,
} from "../../agents-core/src/control.ts";

function validateCurrentSessionCommandAndNotify(
	command: "archive" | "delete" | "unarchive",
	args: string,
	ctx: ExtensionCommandContext,
): CurrentSession | undefined {
	if (args.trim()) {
		ctx.ui.notify(`Usage: /${command}`, "warning");
		return;
	}
	const controlDbPath = ctx.controlDbPath;
	if (!controlDbPath) {
		ctx.ui.notify(`Session ${command} requires a control database.`, "error");
		return;
	}
	const sessionPath = ctx.sessionManager.getSessionFile();
	// A new session has its path before the first message writes the file.
	if (!sessionPath || !existsSync(sessionPath)) {
		ctx.ui.notify("The current session is not persisted.", "warning");
		return;
	}
	return { controlDbPath, sessionPath };
}

async function unarchiveCurrentSession(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const session = validateCurrentSessionCommandAndNotify("unarchive", args, ctx);
	if (!session) return;
	const { controlDbPath, sessionPath } = session;
	if (!readSessionMetadata(controlDbPath, sessionPath)?.isArchived) {
		ctx.ui.notify("Current session is already unarchived.", "info");
		return;
	}
	unarchiveSession(controlDbPath, sessionPath);
	ctx.ui.notify("Unarchived current session.", "info");
}

type CurrentSession = { controlDbPath: string; sessionPath: string };

function archiveAtQuit(session: CurrentSession): void {
	try {
		archivePersistedSession(session.controlDbPath, session.sessionPath);
	} catch (error) {
		throw new Error(`Failed to archive session: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function deleteAtQuit(session: CurrentSession, event: SessionShutdownEvent): Promise<void> {
	if (!event.closeTranscript) throw new Error("Cannot delete session: quit cannot close the transcript to writes.");
	await event.closeTranscript();
	const result = await deleteSessionTree(session.sessionPath, session.controlDbPath);
	if (!result.ok) throw new Error(`Failed to delete session: ${result.error}`);
}

/** Closes the running child agents; a child still running afterwards could keep writing its transcript. */
async function closeRunningChildren(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<boolean> {
	const request: CloseAllAgentsRequest = {
		ownerSessionId: ctx.sessionManager.getSessionId(),
		reason: "closed by /delete",
	};
	pi.events.emit(CLOSE_ALL_AGENTS_EVENT, request);
	if (!request.closed) {
		ctx.ui.notify("Cannot close the running child agents: the agents runtime is unavailable.", "error");
		return false;
	}
	const stillRunning = await request.closed;
	if (stillRunning.length === 0) return true;
	const names = stillRunning.map((agent) => agent.displayName ?? agent.id).join(", ");
	ctx.ui.notify(`Could not close ${names}; the session was not deleted.`, "error");
	return false;
}

export default function sessionArchiveExtension(pi: ExtensionAPI): void {
	// Archive/delete run at quit teardown, before the resume hint is printed.
	let pendingQuitAction: ((event: SessionShutdownEvent) => void | Promise<void>) | undefined;
	const quitWith = (
		action: (session: CurrentSession, event: SessionShutdownEvent) => void | Promise<void>,
		session: CurrentSession,
		ctx: ExtensionCommandContext,
	) => {
		pendingQuitAction = (event) => action(session, event);
		ctx.shutdown();
	};
	pi.on("session_shutdown", async (event) => {
		const action = pendingQuitAction;
		pendingQuitAction = undefined;
		if (event.reason !== "quit" || !action) return;
		try {
			await action(event);
		} catch (error) {
			// The TUI is already stopped at quit, so report on stderr where it stays visible after exit.
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		}
	});
	pi.registerCommand("unarchive", {
		description: "Unarchive the current session",
		handler: unarchiveCurrentSession,
	});
	pi.registerCommand("archive", {
		description: "Archive the current session and quit",
		handler: async (args, ctx) => {
			const session = validateCurrentSessionCommandAndNotify("archive", args, ctx);
			if (session) quitWith(archiveAtQuit, session, ctx);
		},
	});
	pi.registerCommand("delete", {
		description: "Delete the current session and its child agent sessions, then quit",
		handler: async (args, ctx) => {
			const session = validateCurrentSessionCommandAndNotify("delete", args, ctx);
			if (!session) return;
			const running = ctx.multiAgentStore ? runningChildAgents(ctx.multiAgentStore).length : 0;
			const closeStep =
				running === 0 ? "" : `Close the ${running} running child ${running === 1 ? "agent" : "agents"}, `;
			const confirmed = await ctx.ui.confirm(
				"Delete session?",
				`${closeStep}${closeStep ? "delete" : "Delete"} the current session and its child agent sessions, then quit.`,
			);
			if (!confirmed) return;
			if (running > 0 && !(await closeRunningChildren(pi, ctx))) return;
			quitWith(deleteAtQuit, session, ctx);
		},
	});
}
