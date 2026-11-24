import { existsSync } from "node:fs";
import type { AgentToolResult, ExtensionContext } from "../../../src/core/extensions/types.ts";
import type { AgentSnapshot, MultiAgentStore } from "../../../src/core/multi-agent-store.ts";
import { restoreArchivedSession } from "../../../src/core/session-archive-storage.ts";
import { readSessionMetadata } from "../../../src/core/session-control-db.ts";
import { type SessionInfo, SessionManager } from "../../../src/core/session-manager.ts";
import { type AttachSessionInfo, findAttachSessionsById, readStoredSessionModel } from "./attach-session-lookup.ts";
import type { ActiveAgentDispatches, BackgroundSessionHandles, OwnedAgentRuntime } from "./contracts.ts";
import {
	type AgentDesktopNotifier,
	type AgentToolDetails,
	type AttachedSessionFactory,
	type AttachSessionAgentParams,
	CHILD_ORCHESTRATION_UNAVAILABLE_MESSAGE,
	type ChildAgentDispatchInput,
} from "./contracts.ts";
import {
	dispatchReservedAgentSession,
	isChildAgentRuntime,
	releaseOwnershipAfterDispatch,
	resolveConfiguredAgentProfile,
} from "./dispatch.ts";
import type { WaitingDesktopNotificationHandles } from "./dispatch-pipeline.ts";
import { runAgentSession, startToolDispatch } from "./dispatch-pipeline.ts";
import { createLifecycleCoordinator } from "./lifecycle-runtime.ts";
import { emptyAgent, result } from "./messaging.ts";

export interface AttachSessionAgentRuntimeInput {
	createAttachedSession: AttachedSessionFactory | undefined;
	ctx: ExtensionContext;
	desktopNotifier: AgentDesktopNotifier;
	dispatches: ActiveAgentDispatches;
	handles?: BackgroundSessionHandles;
	params: AttachSessionAgentParams;
	ownerships: Map<string, OwnedAgentRuntime>;
	store: MultiAgentStore;
	waitingDesktopNotifications: WaitingDesktopNotificationHandles;
}

export async function attachSessionAgent(
	input: AttachSessionAgentRuntimeInput,
): Promise<AgentToolResult<AgentToolDetails>> {
	const { ctx, params, store } = input;
	if (isChildAgentRuntime(ctx)) {
		return result(CHILD_ORCHESTRATION_UNAVAILABLE_MESSAGE, {
			agent: emptyAgent("attach_session_agent"),
			dispatched: false,
		});
	}
	const resolution = await resolveAttachSessionTarget(params, ctx);
	if (!resolution.ok) {
		return result(resolution.message, {
			agent: emptyAgent("attach_session_agent"),
			dispatched: false,
		});
	}
	const resolved = resolution.target;

	const prompt = params.prompt?.trim();
	if (prompt && !input.createAttachedSession) {
		return result(`Could not resume session ${resolved.sessionId}: no attached session runtime is configured.`, {
			agent: emptyAgent("attach_session_agent"),
			dispatched: false,
			prompt,
		});
	}

	const attached = spawnAttachedSessionAgent(store, params, resolved, ctx);
	if (!attached.ok) {
		return result(`Could not attach session ${resolved.sessionId}: ${attached.error}`, {
			agent: attached.parent ?? emptyAgent(params.parentId ?? "attach_session_agent"),
			dispatched: false,
		});
	}

	const dispatched = prompt
		? dispatchAttachedSessionAgent({
				createAttachedSession: input.createAttachedSession,
				ctx,
				desktopNotifier: input.desktopNotifier,
				dispatches: input.dispatches,
				handles: input.handles,
				ownerships: input.ownerships,
				prompt,
				store,
				target: attached.agent,
				waitingDesktopNotifications: input.waitingDesktopNotifications,
			})
		: undefined;
	if (dispatched) {
		return result(`Attached and resumed ${dispatched.displayName} (${dispatched.id})`, {
			agent: dispatched,
			dispatched: true,
			prompt,
		});
	}

	return result(`Attached ${attached.agent.displayName} (${attached.agent.id})`, {
		agent: attached.agent,
		dispatched: false,
	});
}

export interface AttachSessionTarget {
	cwd: string;
	name?: string;
	path: string;
	sessionId: string;
}

export type AttachSessionTargetResolution = { ok: true; target: AttachSessionTarget } | { ok: false; message: string };

export interface AttachSessionDispatchInput {
	createAttachedSession: AttachedSessionFactory | undefined;
	ctx: ExtensionContext;
	desktopNotifier: AgentDesktopNotifier;
	dispatches: ActiveAgentDispatches;
	handles?: BackgroundSessionHandles;
	ownerships: Map<string, OwnedAgentRuntime>;
	prompt: string;
	store: MultiAgentStore;
	target: AgentSnapshot;
	waitingDesktopNotifications: WaitingDesktopNotificationHandles;
}

export type AttachSessionResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: string; parent?: AgentSnapshot };

export function dispatchAttachedSessionAgent(input: AttachSessionDispatchInput): AgentSnapshot | undefined {
	const reservedRuntime = reserveAttachedRuntime(input);
	if (!reservedRuntime) return undefined;
	const target = reservedRuntime.lifecycle.agent;
	input.ownerships.set(target.id, reservedRuntime);
	input.store.publishLifecycleCoordinatorSnapshot(target);
	const createAttachedSession = input.createAttachedSession;
	if (!createAttachedSession) return undefined;
	const dispatched = startToolDispatch(
		input.store,
		input.dispatches,
		target,
		() => dispatchReservedAttachedChildSession(input, createAttachedSession, reservedRuntime),
		input.desktopNotifier,
		input.waitingDesktopNotifications,
		input.handles,
		reservedRuntime,
	);
	releaseOwnershipAfterDispatch(input.dispatches, input.ownerships, target.id);
	return dispatched;
}

export function reserveAttachedRuntime(input: AttachSessionDispatchInput): OwnedAgentRuntime | undefined {
	const coordinator = createLifecycleCoordinator(input.store);
	if (!coordinator) return undefined;
	const persistence = input.store.getPersistenceTarget();
	if (!persistence) return undefined;
	const ownerSessionId = input.ctx.sessionManager?.getSessionId() ?? persistence.sessionPath;
	const acquired = coordinator.acquireAttachedRuntime(input.target, ownerSessionId);
	if (!acquired.ok) return undefined;
	return {
		abortController: new AbortController(),
		coordinator,
		lifecycle: { agent: acquired.agent, ownership: acquired.ownership },
	};
}

export function dispatchReservedAttachedChildSession(
	input: AttachSessionDispatchInput,
	createAttachedSession: AttachedSessionFactory,
	reservedRuntime: OwnedAgentRuntime,
): Promise<AgentSnapshot> {
	const factory = (dispatchInput: ChildAgentDispatchInput) =>
		createAttachedSession({ ...dispatchInput, sessionPath: input.target.transcript?.path ?? "" });
	if (reservedRuntime.lifecycle.agent.lifecycle === "waiting_for_input") {
		return dispatchReservedAgentSession(
			input.store,
			factory,
			reservedRuntime,
			input.prompt,
			input.ctx,
			input.handles,
		);
	}
	return runAgentSession(
		input.store,
		factory,
		reservedRuntime.lifecycle.agent,
		input.prompt,
		input.ctx,
		input.handles,
		undefined,
		reservedRuntime,
	);
}

export function spawnAttachedSessionAgent(
	store: MultiAgentStore,
	params: AttachSessionAgentParams,
	resolved: AttachSessionTarget,
	ctx: ExtensionContext,
): AttachSessionResult {
	const agentType = params.agentType?.trim() || "resumed-session";
	const displayName = params.displayName?.trim() || resolved.name || `Session ${resolved.sessionId}`;
	const profile = resolveConfiguredAgentProfile(agentType, ctx);
	const permission = buildAttachedSessionPermission(store, params.parentId);
	const parent = params.parentId ? store.getAgent(params.parentId) : undefined;
	const coordinator = createLifecycleCoordinator(store);
	if (!coordinator) return { ok: false, error: "lifecycle_coordinator_unavailable" };
	const attached = coordinator.createAttachment({
		account: parent?.account,
		agentType,
		cwd: resolved.cwd || ctx.cwd,
		displayName,
		model: readStoredSessionModel(ctx.controlDbPath, resolved.path) ?? profile?.modelMetadata ?? parent?.model,
		parentId: params.parentId,
		permission,
		transcript: { path: resolved.path, sessionId: resolved.sessionId },
	});
	if (!attached.ok) {
		return { ok: false, error: attached.error, parent };
	}
	store.publishLifecycleCoordinatorSnapshot(attached.agent);
	return attached;
}

export function buildAttachedSessionPermission(
	store: MultiAgentStore,
	parentId: string | undefined,
): AgentSnapshot["permission"] {
	if (!parentId) {
		return { narrowed: true, policy: "on-request" };
	}
	const parent = store.getAgent(parentId);
	return { inheritedFrom: parentId, narrowed: true, policy: parent?.permission.policy ?? "on-request" };
}

export async function resolveAttachSessionTarget(
	params: AttachSessionAgentParams,
	ctx: ExtensionContext,
): Promise<AttachSessionTargetResolution> {
	const path = params.path?.trim();
	const sessionId = params.sessionId?.trim();
	const name = params.name?.trim();
	if (countAttachSessionSelectors({ name, path, sessionId }) !== 1) {
		return { ok: false, message: "Could not attach session: provide exactly one of path, sessionId, or name." };
	}
	if (path) {
		const restoredPath = ctx.controlDbPath ? restoreArchivedSession(ctx.controlDbPath, path) : path;
		// SessionManager.open() starts a new session for a missing file; attaching requires an existing transcript.
		if (!existsSync(restoredPath))
			return { ok: false, message: `Could not attach session: no transcript at ${path}.` };
		const session = SessionManager.open(restoredPath, ctx.sessionManager?.getSessionDir());
		const sessionPath = session.getSessionFile() ?? restoredPath;
		const metadata = ctx.controlDbPath ? readSessionMetadata(ctx.controlDbPath, sessionPath) : undefined;
		return {
			ok: true,
			target: {
				// Control metadata holds the current cwd; the opened transcript reports only its initial header cwd.
				cwd: metadata?.cwd || session.getCwd(),
				name: metadata?.name || metadata?.subagentName,
				path: sessionPath,
				sessionId: session.getSessionId(),
			},
		};
	}
	const match = await findAttachSessionMatch(ctx, { name, sessionId });
	if (match.status === "ambiguous") {
		return { ok: false, message: `Could not attach session: ${match.selector} matches multiple sessions.` };
	}
	if (match.status === "not_found") {
		return { ok: false, message: "Could not attach session: session not found." };
	}
	return {
		ok: true,
		target: {
			cwd: match.session.cwd,
			name: match.session.name,
			path: match.session.path,
			sessionId: match.session.id,
		},
	};
}

export function countAttachSessionSelectors(target: { name?: string; path?: string; sessionId?: string }): number {
	const selectors = [target.name, target.path, target.sessionId];
	return selectors.filter((value) => value !== undefined && value !== "").length;
}

export type AttachSessionMatchResult =
	| { status: "found"; session: AttachSessionInfo }
	| { status: "ambiguous"; selector: string }
	| { status: "not_found" };

export async function findAttachSessionMatch(
	ctx: ExtensionContext,
	target: { name?: string; sessionId?: string },
): Promise<AttachSessionMatchResult> {
	const sessionDir = ctx.sessionManager?.getSessionDir();
	if (target.sessionId) {
		return findMatchingSession(await findAttachSessionsById(target.sessionId, sessionDir, ctx.controlDbPath), target);
	}
	const localSessions = await SessionManager.list(ctx.cwd, sessionDir, undefined, ctx.controlDbPath);
	const allSessions = await SessionManager.listAll(sessionDir, undefined, ctx.controlDbPath);
	return findMatchingSession(dedupeSessionsByPath([...localSessions, ...allSessions]), target);
}

export function dedupeSessionsByPath(sessions: SessionInfo[]): SessionInfo[] {
	const deduped = new Map<string, SessionInfo>();
	for (const session of sessions) {
		deduped.set(session.path, session);
	}
	return [...deduped.values()];
}

export function findMatchingSession(
	sessions: AttachSessionInfo[],
	target: { name?: string; sessionId?: string },
): AttachSessionMatchResult {
	const sessionId = target.sessionId;
	if (sessionId) {
		const exactMatches = sessions.filter((session) => session.id === sessionId);
		if (exactMatches.length > 1) {
			return { status: "ambiguous", selector: sessionId };
		}
		if (exactMatches[0]) {
			return { status: "found", session: exactMatches[0] };
		}
		const prefixMatches = sessions.filter((session) => session.id.startsWith(sessionId));
		if (prefixMatches.length > 1) {
			return { status: "ambiguous", selector: sessionId };
		}
		return prefixMatches[0] ? { status: "found", session: prefixMatches[0] } : { status: "not_found" };
	}
	const nameMatches = sessions.filter((session) => session.name === target.name);
	if (nameMatches.length > 1) {
		return { status: "ambiguous", selector: target.name ?? "name" };
	}
	return nameMatches[0] ? { status: "found", session: nameMatches[0] } : { status: "not_found" };
}
