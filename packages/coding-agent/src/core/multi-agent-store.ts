import { isAbsolute } from "node:path";
import type { ProcessIdentity } from "./runtime-process.ts";
import {
	allocateMultiAgentCounter,
	type MultiAgentPersistedState,
	readMultiAgentState,
	updateMultiAgentAgentActivity,
	updateMultiAgentAgentCurrentActivity,
	updateMultiAgentAgentSlot,
	updateMultiAgentAgentTranscript,
	upsertMultiAgentMailboxMessage,
} from "./session-control-db.ts";
import type { SessionManager } from "./session-manager.ts";

export type AgentLifecycleState =
	| "running"
	| "waiting_for_input"
	| "steering_pending"
	| "cancelling"
	| "completed"
	| "failed"
	| "aborted";

export type TerminalAgentLifecycleState = "completed" | "failed" | "aborted";

export type SteeringCheckpoint = "next_model_call" | "after_tool_result" | "when_waiting";

export type MailboxMessageKind = "message" | "ask" | "reply" | "steer" | "supervisor_request" | "system";

export type MailboxMessageStatus = "pending" | "claimed" | "accepted" | "rejected" | "delivered" | "failed";

export interface AgentActivity {
	description: string;
	toolName?: string;
}

export type AgentCurrentActivity =
	| { phase: "thinking"; startedAt: string }
	| { phase: "tool"; startedAt: string; toolCallId: string; toolName: string };

export interface AgentCurrentActivityOwner {
	ownerSessionId: string;
	processIdentity: ProcessIdentity;
}

export interface AgentFileReference {
	path: string;
	label?: string;
}

export interface AgentResult {
	summary?: string;
	fileRefs?: AgentFileReference[];
	durationMs?: number;
	toolCallId?: string;
}

export interface AgentWorkerAdapter {
	adapter: "runtime" | "terminal" | "subprocess";
	handleId: string;
	cwd?: string;
	/** Tool call in the owning agent that spawned this detached runtime worker, if any. */
	toolCallId?: string;
}

export interface AgentTranscriptMetadata {
	sessionId: string;
	path?: string;
}

export interface AgentEventStreamMetadata {
	path: string;
	eventCount: number;
	truncated: boolean;
	byteLimit?: number;
}

export interface AgentNode {
	id: string;
	parentId: string | undefined;
	displayName: string;
	agentType: string;
	/** How the agent entered the store; absent means spawned as a child agent. */
	origin?: "attached" | "spawned";
	lifecycle: AgentLifecycleState;
	revision: number;
	createdAt: string;
	updatedAt: string;
	cwd: string;
	worktree?: { path: string; branch?: string; base?: string };
	model?: { providerId: string; modelId: string; thinkingLevel?: string };
	account?: {
		id: string;
		budgetId?: string;
		providerFallback?: string[];
		tokenBudget?: { limit: number };
		concurrencyCap?: number;
		rateLimit?: { perMinute: number };
	};
	permission: { policy: string; inheritedFrom?: string; narrowed: boolean };
	slot?: { index: number; pinned: boolean };
	transcript?: AgentTranscriptMetadata;
	eventStream?: AgentEventStreamMetadata;
	worker?: AgentWorkerAdapter;
	currentActivity?: AgentCurrentActivity;
	lastActivity?: AgentActivity;
	result?: AgentResult;
	error?: { message: string; code?: string };
}

export type AgentSnapshot = AgentNode;

export interface SpawnAgentInput {
	parentId?: string;
	displayName: string;
	agentType: string;
	origin?: AgentNode["origin"];
	cwd: string;
	permission: AgentNode["permission"];
	worktree?: AgentNode["worktree"];
	model?: AgentNode["model"];
	account?: AgentNode["account"];
	slot?: AgentNode["slot"];
	transcript?: AgentNode["transcript"];
	eventStream?: AgentNode["eventStream"];
	worker?: AgentNode["worker"];
}

export type SpawnChildAgentInput = Omit<SpawnAgentInput, "account" | "model" | "parentId"> & {
	account?: AgentNode["account"];
	model?: AgentNode["model"];
};

export type AttachSessionAgentInput = SpawnChildAgentInput & {
	transcript: AgentTranscriptMetadata;
};

export interface AgentMailboxMessage {
	id: string;
	threadId?: string;
	fromAgentId: string;
	toAgentId: string;
	kind: MailboxMessageKind;
	status: MailboxMessageStatus;
	createdAt: string;
	updatedAt: string;
	body?: string;
	fileRefs?: AgentFileReference[];
	targetCheckpoint?: SteeringCheckpoint;
	error?: string;
}

export interface SendSteeringInput {
	fromAgentId: string;
	body: string;
	targetCheckpoint?: SteeringCheckpoint;
	threadId?: string;
	fileRefs?: AgentFileReference[];
}

export interface ContactSupervisorInput {
	body: string;
	threadId?: string;
	fileRefs?: AgentFileReference[];
}

export interface SendMailboxMessageInput {
	body: string;
	toAgentId: string;
	threadId?: string;
	fileRefs?: AgentFileReference[];
}

type AgentLifecycleNotificationLifecycle = "completed" | "failed" | "waiting_for_input";

interface AgentLifecycleNotificationInput {
	body: string;
	fileRefs?: AgentFileReference[];
	threadId: string;
}

export type AgentCommandResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: "not_found"; agentId: string }
	| { ok: false; error: "stale_revision"; current: AgentSnapshot }
	| { ok: false; error: "invalid_transition"; current: AgentSnapshot; requested: AgentLifecycleState };

export type SpawnChildAgentResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: "parent_not_found"; parentId: string }
	| { ok: false; error: "permission_broadened"; parent: AgentSnapshot; requested: AgentNode["permission"] };

export type SupervisorContactResult =
	| { ok: true; agent: AgentSnapshot; message: AgentMailboxMessage }
	| { ok: false; error: "not_found"; agentId: string }
	| { ok: false; error: "stale_revision"; current: AgentSnapshot };

export type MailboxMessageCommandResult =
	| { ok: true; agent: AgentSnapshot; message: AgentMailboxMessage }
	| { ok: false; error: "not_found"; agentId: string }
	| { ok: false; error: "target_not_found"; current: AgentSnapshot; targetId: string }
	| { ok: false; error: "stale_revision"; current: AgentSnapshot }
	| { ok: false; error: "forbidden_target"; current: AgentSnapshot; target: AgentSnapshot };

export type AgentMetadataCommandResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: "not_found"; agentId: string }
	| { ok: false; error: "stale_revision"; current: AgentSnapshot; projection: MultiAgentProjectionSnapshot }
	| {
			ok: false;
			error: "slot_conflict";
			current: AgentSnapshot;
			occupant: AgentSnapshot;
			projection: MultiAgentProjectionSnapshot;
	  };

export type AgentTranscriptCommandResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: "not_found"; agentId: string };

export type AgentViewSelectionResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: "not_found"; agentId: string };

export type ActiveAgentTargetSelectionResult =
	| AgentViewSelectionResult
	| { ok: false; error: "inactive"; agent: AgentSnapshot };

export interface MultiAgentStoreOptions {
	now?: () => string;
}

export type AgentLifecycleNotificationListener = (message: AgentMailboxMessage) => void;
export type AgentTransitionListener = (previous: AgentSnapshot, current: AgentSnapshot) => void;
export type AgentUpdateListener = (previous: AgentSnapshot, current: AgentSnapshot) => void;

export interface AgentSlotProjection {
	agentId: string;
	agent: AgentSnapshot;
	index: number;
	pinned: boolean;
	revision: number;
}

export interface AgentRowProjection {
	agentId: string;
	displayName: string;
	lifecycle: AgentLifecycleState;
	revision: number;
	active: boolean;
	selected: boolean;
	slotIndex?: number;
	workerAdapter?: AgentWorkerAdapter["adapter"];
}

export interface MultiAgentProjectionSnapshot {
	activeCount: number;
	agents: AgentSnapshot[];
	mailboxMessages: AgentMailboxMessage[];
	rows: AgentRowProjection[];
	selectedAgentId?: string;
	slots: AgentSlotProjection[];
}

const COMPLETION_NOTIFICATION_THREAD_PREFIX = "agent-completed";
const FAILED_NOTIFICATION_THREAD_PREFIX = "agent-failed";
const WAITING_FOR_INPUT_NOTIFICATION_THREAD_PREFIX = "agent-waiting-for-input";
const MAIN_THREAD_AGENT_ID = "main";
const TERMINAL_STATES = new Set<AgentLifecycleState>(["completed", "failed", "aborted"]);

export class MultiAgentStore {
	private readonly agents = new Map<string, AgentNode>();
	private readonly mailboxMessages = new Map<string, AgentMailboxMessage>();
	private readonly lifecycleNotificationListeners = new Set<AgentLifecycleNotificationListener>();
	private readonly transitionListeners = new Set<AgentTransitionListener>();
	private readonly updateListeners = new Set<AgentUpdateListener>();
	private readonly abortHandlers = new Map<string, () => void>();
	private readonly now: () => string;
	private nextAgentNumber = 1;
	private nextMessageNumber = 1;
	private restoreGeneration = 0;
	private persistence: { controlDbPath: string; sessionPath: string } | undefined;
	private selectedAgentId: string | undefined;

	constructor(options: MultiAgentStoreOptions = {}) {
		this.now = options.now ?? (() => new Date().toISOString());
	}

	subscribeLifecycleNotifications(listener: AgentLifecycleNotificationListener): () => void {
		this.lifecycleNotificationListeners.add(listener);
		return () => this.lifecycleNotificationListeners.delete(listener);
	}

	subscribeAgentTransitions(listener: AgentTransitionListener): () => void {
		this.transitionListeners.add(listener);
		return () => this.transitionListeners.delete(listener);
	}

	subscribeAgentUpdates(listener: AgentUpdateListener): () => void {
		this.updateListeners.add(listener);
		return () => this.updateListeners.delete(listener);
	}

	registerAgentAbortHandler(agentId: string, handler: () => void): () => void {
		this.abortHandlers.set(agentId, handler);
		return () => {
			if (this.abortHandlers.get(agentId) === handler) {
				this.abortHandlers.delete(agentId);
			}
		};
	}

	abortAgentHandle(agentId: string): boolean {
		const handler = this.abortHandlers.get(agentId);
		if (!handler) {
			return false;
		}
		this.abortHandlers.delete(agentId);
		handler();
		return true;
	}

	allocateAgentIdForLifecycleCoordinator(prefix: "agent" | "bash" | "pyrun" = "agent"): string {
		return this.createAgentId(prefix);
	}

	prepareSteeringMessageForLifecycleCoordinator(agentId: string, input: SendSteeringInput): AgentMailboxMessage {
		const timestamp = this.now();
		return {
			body: input.body,
			createdAt: timestamp,
			fileRefs: validateFileRefs(input.fileRefs, "steer_agent"),
			fromAgentId: input.fromAgentId,
			id: this.createMessageId(),
			kind: "steer",
			status: "pending",
			targetCheckpoint: input.targetCheckpoint,
			threadId: input.threadId,
			toAgentId: agentId,
			updatedAt: timestamp,
		};
	}

	publishLifecycleCoordinatorSteering(agent: AgentSnapshot, message: AgentMailboxMessage): void {
		const previous = this.agents.get(agent.id);
		const current = copyAgent(agent);
		this.mailboxMessages.set(message.id, copyMessage(message));
		this.agents.set(agent.id, current);
		if (!previous) return;
		this.notifyAgentUpdateListeners(previous, current);
		this.notifyTransitionListenersIfLifecycleChanged(previous, current);
	}

	publishLifecycleCoordinatorSteeringDelivery(agent: AgentSnapshot, message: AgentMailboxMessage): void {
		this.publishLifecycleCoordinatorSteering(agent, message);
	}

	publishLifecycleCoordinatorSnapshot(agent: AgentSnapshot): void {
		const previous = this.agents.get(agent.id);
		const current = copyAgent(agent);
		this.agents.set(agent.id, current);
		if (!previous) return;
		this.notifyAgentUpdateListeners(previous, current);
		if (previous.lifecycle === current.lifecycle) return;
		if (current.lifecycle === "waiting_for_input") this.recordWaitingForInputNotification(current);
		this.notifyTransitionListenersIfLifecycleChanged(previous, current);
	}

	publishTerminalOutboxSnapshot(agent: AgentSnapshot): void {
		const previous = this.agents.get(agent.id);
		const current = copyAgent(agent);
		this.agents.set(agent.id, current);
		if (current.lifecycle === "completed") this.retryOrRecordTerminalNotification(current, "completed");
		if (current.lifecycle === "failed" || current.lifecycle === "aborted") {
			this.retryOrRecordTerminalNotification(current, "failed");
		}
		if (!previous) return;
		this.notifyAgentUpdateListeners(previous, current);
		this.notifyTransitionListenersIfLifecycleChanged(previous, current);
		if (this.selectedAgentId === current.id) this.selectedAgentId = undefined;
	}

	selectAgentView(agentId: string): AgentSnapshot | undefined {
		const result = this.selectAgentViewWithStatus(agentId);
		return result.ok ? result.agent : undefined;
	}

	selectAgentViewWithStatus(agentId: string): AgentViewSelectionResult {
		const agent = this.agents.get(agentId);
		if (!agent) {
			return { ok: false, error: "not_found", agentId };
		}

		this.selectedAgentId = agent.id;

		return { ok: true, agent: copyAgent(agent) };
	}

	selectActiveAgentTarget(agentId: string): AgentSnapshot | undefined {
		const result = this.selectActiveAgentTargetWithStatus(agentId);
		return result.ok ? result.agent : undefined;
	}

	selectActiveAgentTargetWithStatus(agentId: string): ActiveAgentTargetSelectionResult {
		const agent = this.agents.get(agentId);
		if (!agent) {
			return { ok: false, error: "not_found", agentId };
		}
		if (!isActiveLifecycle(agent.lifecycle)) {
			return { ok: false, error: "inactive", agent: copyAgent(agent) };
		}

		this.selectedAgentId = agent.id;
		return { ok: true, agent: copyAgent(agent) };
	}

	selectAgentSlot(slotIndex: number): AgentSnapshot | undefined {
		const result = this.selectAgentSlotWithStatus(slotIndex);
		return result.ok ? result.agent : undefined;
	}

	selectAgentSlotWithStatus(slotIndex: number): AgentViewSelectionResult {
		const selectedAgent = this.findAgentForSlotSelection(slotIndex);
		if (!selectedAgent) {
			return { ok: false, error: "not_found", agentId: String(slotIndex) };
		}

		this.selectedAgentId = selectedAgent.id;
		return { ok: true, agent: copyAgent(selectedAgent) };
	}

	selectActiveAgentSlotTarget(slotIndex: number): AgentSnapshot | undefined {
		const result = this.selectActiveAgentSlotTargetWithStatus(slotIndex);
		return result.ok ? result.agent : undefined;
	}

	selectActiveAgentSlotTargetWithStatus(slotIndex: number): ActiveAgentTargetSelectionResult {
		const selectedAgent = this.findAgentForSlotSelection(slotIndex);
		if (!selectedAgent) {
			return { ok: false, error: "not_found", agentId: String(slotIndex) };
		}
		if (!isActiveLifecycle(selectedAgent.lifecycle)) {
			return { ok: false, error: "inactive", agent: copyAgent(selectedAgent) };
		}

		this.selectedAgentId = selectedAgent.id;
		return { ok: true, agent: copyAgent(selectedAgent) };
	}

	getSelectedAgentId(): string | undefined {
		return this.selectedAgentId;
	}

	clearSelectedAgentView(): void {
		this.selectedAgentId = undefined;
	}

	getAgent(agentId: string): AgentSnapshot | undefined {
		const agent = this.agents.get(agentId);
		return agent ? copyAgent(agent) : undefined;
	}

	listAgents(): AgentSnapshot[] {
		return Array.from(this.agents.values(), copyAgent);
	}

	listDescendants(parentId: string): AgentSnapshot[] {
		const descendants: AgentNode[] = [];

		const visitChildren = (currentParentId: string) => {
			for (const agent of this.agents.values()) {
				if (agent.parentId !== currentParentId) {
					continue;
				}

				descendants.push(agent);
				visitChildren(agent.id);
			}
		};

		visitChildren(parentId);

		return descendants.map(copyAgent);
	}

	listMailboxMessages(): AgentMailboxMessage[] {
		return Array.from(this.mailboxMessages.values(), copyMessage);
	}

	listPendingMailboxMessagesForAgent(agentId: string): AgentMailboxMessage[] {
		return Array.from(this.mailboxMessages.values())
			.filter((message) => message.toAgentId === agentId && message.status === "pending")
			.map(copyMessage);
	}

	markMailboxMessageDelivered(messageId: string): AgentMailboxMessage | undefined {
		return this.markMailboxMessageStatus(messageId, "delivered");
	}

	markMailboxMessageFailed(messageId: string, error: string): AgentMailboxMessage | undefined {
		return this.markMailboxMessageStatus(messageId, "failed", error);
	}

	private markMailboxMessageStatus(
		messageId: string,
		status: Exclude<MailboxMessageStatus, "pending">,
		error?: string,
	): AgentMailboxMessage | undefined {
		const message = this.mailboxMessages.get(messageId);
		if (!message || message.status !== "pending") {
			return undefined;
		}

		const updated = { ...message, error, status, updatedAt: this.now() };
		this.putMailboxMessage(updated);
		return copyMessage(updated);
	}

	consumeCompletionNotificationsForAgent(agentId: string): AgentMailboxMessage[] {
		return this.consumeLifecycleNotificationsForAgent(agentId, "completed");
	}

	consumeFailureNotificationsForAgent(agentId: string): AgentMailboxMessage[] {
		return this.consumeLifecycleNotificationsForAgent(agentId, "failed");
	}

	private consumeLifecycleNotificationsForAgent(
		agentId: string,
		lifecycle: AgentLifecycleNotificationLifecycle,
	): AgentMailboxMessage[] {
		const consumed: AgentMailboxMessage[] = [];
		for (const message of this.mailboxMessages.values()) {
			if (!isPendingLifecycleNotification(message, agentId, lifecycle)) {
				continue;
			}
			const updated = { ...message, status: "delivered" as const, updatedAt: this.now() };
			this.putMailboxMessage(updated);
			consumed.push(copyMessage(updated));
		}
		return consumed;
	}

	listPendingLifecycleNotificationsForAgent(
		agentId: string,
		lifecycle: AgentLifecycleNotificationLifecycle,
	): AgentMailboxMessage[] {
		return Array.from(this.mailboxMessages.values())
			.filter((message) => isPendingLifecycleNotification(message, agentId, lifecycle))
			.map(copyMessage);
	}

	getProjectionSnapshot(): MultiAgentProjectionSnapshot {
		return {
			activeCount: this.getActiveAgentCount(),
			agents: this.listAgents(),
			mailboxMessages: this.listMailboxMessages(),
			rows: this.listRowProjections(),
			selectedAgentId: this.selectedAgentId,
			slots: this.listSlotProjections(),
		};
	}

	listActiveAgents(): AgentSnapshot[] {
		return this.listAgents().filter((agent) => isActiveLifecycle(agent.lifecycle));
	}

	getActiveAgentCount(): number {
		let activeCount = 0;

		for (const agent of this.agents.values()) {
			if (isActiveLifecycle(agent.lifecycle)) {
				activeCount += 1;
			}
		}

		return activeCount;
	}

	pinAgentSlot(agentId: string, expectedRevision: number, slotIndex: number): AgentMetadataCommandResult {
		const current = this.agents.get(agentId);
		if (!current) {
			return { ok: false, error: "not_found", agentId };
		}

		if (current.revision !== expectedRevision) {
			return {
				ok: false,
				error: "stale_revision",
				current: copyAgent(current),
				projection: this.getProjectionSnapshot(),
			};
		}

		const occupant = this.findSlotOccupant(slotIndex, current.id);
		if (occupant) {
			return {
				ok: false,
				error: "slot_conflict",
				current: copyAgent(current),
				occupant: copyAgent(occupant),
				projection: this.getProjectionSnapshot(),
			};
		}

		const updated = this.updateAgentMetadata(current, {
			slot: { index: slotIndex, pinned: true },
		});
		return { ok: true, agent: copyAgent(updated) };
	}

	publishAgentCurrentActivity(
		agentId: string,
		currentActivity: AgentCurrentActivity | undefined,
		ownership?: AgentCurrentActivityOwner,
	): AgentSnapshot | undefined {
		const current = this.agents.get(agentId);
		if (!current) {
			return undefined;
		}
		if (currentActivity && current.lifecycle !== "running" && current.lifecycle !== "steering_pending") {
			return undefined;
		}
		if (this.persistence && !ownership) {
			throw new Error(`Persisted agent ${agentId} activity update requires exact runtime ownership`);
		}

		return copyAgent(this.updateAgentMetadata(current, { currentActivity }, ownership));
	}

	updateAgentTranscript(agentId: string, transcript: AgentTranscriptMetadata): AgentTranscriptCommandResult {
		const current = this.agents.get(agentId);
		if (!current) {
			return { ok: false, error: "not_found", agentId };
		}

		validateOptionalPath(transcript.path, "update_agent_transcript.path");
		const updated = this.updateAgentMetadata(current, {
			transcript: copyTranscript(transcript),
		});
		return { ok: true, agent: copyAgent(updated) };
	}

	clearAgentSlot(agentId: string, expectedRevision: number): AgentMetadataCommandResult {
		const current = this.agents.get(agentId);
		if (!current) {
			return { ok: false, error: "not_found", agentId };
		}

		if (current.revision !== expectedRevision) {
			return {
				ok: false,
				error: "stale_revision",
				current: copyAgent(current),
				projection: this.getProjectionSnapshot(),
			};
		}

		const updated = this.updateAgentMetadata(current, {
			slot: undefined,
		});
		return { ok: true, agent: copyAgent(updated) };
	}

	contactSupervisor(agentId: string, input: ContactSupervisorInput): SupervisorContactResult {
		const current = this.agents.get(agentId);
		if (!current) {
			return { ok: false, error: "not_found", agentId };
		}

		const timestamp = this.now();
		const message: AgentMailboxMessage = {
			id: this.createMessageId(),
			threadId: input.threadId,
			fromAgentId: current.id,
			toAgentId: current.parentId ?? "supervisor",
			kind: "supervisor_request",
			status: "pending",
			createdAt: timestamp,
			updatedAt: timestamp,
			body: input.body,
			fileRefs: validateFileRefs(input.fileRefs, "contact_supervisor"),
		};
		this.putMailboxMessage(message);

		const updated = this.updateAgentMetadata(current, {
			lastActivity: { description: "Contacted supervisor" },
		});

		return { ok: true, agent: copyAgent(updated), message: copyMessage(message) };
	}

	sendMainThreadMailboxMessage(input: SendMailboxMessageInput): MailboxMessageCommandResult {
		const target = this.agents.get(input.toAgentId);
		const mainThread = this.createMainThreadSnapshot();
		if (!target) {
			return { ok: false, error: "target_not_found", current: mainThread, targetId: input.toAgentId };
		}

		if (!this.isMainThreadChild(target)) {
			return { ok: false, error: "forbidden_target", current: mainThread, target: copyAgent(target) };
		}

		const timestamp = this.now();
		const message: AgentMailboxMessage = {
			id: this.createMessageId(),
			threadId: input.threadId,
			fromAgentId: MAIN_THREAD_AGENT_ID,
			toAgentId: target.id,
			kind: "message",
			status: "pending",
			createdAt: timestamp,
			updatedAt: timestamp,
			body: input.body,
			fileRefs: validateFileRefs(input.fileRefs, "send_agent_message"),
		};
		this.putMailboxMessage(message);

		const updated = this.updateAgentMetadata(target, {
			lastActivity: { description: "Received mailbox message" },
		});

		return { ok: true, agent: copyAgent(updated), message: copyMessage(message) };
	}

	sendMailboxMessage(
		agentId: string,
		expectedRevision: number,
		input: SendMailboxMessageInput,
	): MailboxMessageCommandResult {
		const current = this.agents.get(agentId);
		if (!current) {
			return { ok: false, error: "not_found", agentId };
		}

		const revisionCheck = this.checkRevision(current, expectedRevision);
		if (revisionCheck) {
			return revisionCheck;
		}

		const target = this.agents.get(input.toAgentId);
		if (!target) {
			return { ok: false, error: "target_not_found", current: copyAgent(current), targetId: input.toAgentId };
		}

		if (!this.canSendDirectMessage(current.id, target.id)) {
			return { ok: false, error: "forbidden_target", current: copyAgent(current), target: copyAgent(target) };
		}

		const timestamp = this.now();
		const message: AgentMailboxMessage = {
			id: this.createMessageId(),
			threadId: input.threadId,
			fromAgentId: current.id,
			toAgentId: target.id,
			kind: "message",
			status: "pending",
			createdAt: timestamp,
			updatedAt: timestamp,
			body: input.body,
			fileRefs: validateFileRefs(input.fileRefs, "send_agent_message"),
		};
		this.putMailboxMessage(message);

		const updated = this.updateAgentMetadata(current, {
			lastActivity: { description: "Sent mailbox message" },
		});

		return { ok: true, agent: copyAgent(updated), message: copyMessage(message) };
	}

	/** Record a message addressed to another session; the target is not an agent in this store. */
	recordOutboundSessionMessage(input: {
		fromAgentId: string;
		toAgentId: string;
		body: string;
		threadId?: string;
		fileRefs?: AgentFileReference[];
	}): AgentMailboxMessage {
		const timestamp = this.now();
		const message: AgentMailboxMessage = {
			fileRefs: validateFileRefs(input.fileRefs, "record_outbound_session_message"),
			body: input.body,
			createdAt: timestamp,
			fromAgentId: input.fromAgentId,
			id: this.createMessageId(),
			kind: "message",
			status: "pending",
			threadId: input.threadId,
			toAgentId: input.toAgentId,
			updatedAt: timestamp,
		};
		this.putMailboxMessage(message);
		return copyMessage(message);
	}

	getRestoreGeneration(): number {
		return this.restoreGeneration;
	}

	getPersistenceTarget(): { controlDbPath: string; sessionPath: string } | undefined {
		return this.persistence ? { ...this.persistence } : undefined;
	}

	invalidateInFlightDispatches(): void {
		this.restoreGeneration += 1;
	}

	setPersistenceSessionManager(sessionManager: SessionManager | undefined): void {
		const controlDbPath = sessionManager?.getMetadataControlDbPath();
		const sessionPath = sessionManager?.getSessionFile();
		this.persistence = controlDbPath && sessionPath ? { controlDbPath, sessionPath } : undefined;
	}

	restoreFromSessionManager(sessionManager: SessionManager): void {
		this.setPersistenceSessionManager(sessionManager);
		this.restoreGeneration += 1;
		const state = this.persistence
			? readMultiAgentState(this.persistence.controlDbPath, this.persistence.sessionPath)
			: undefined;
		this.restoreState(state);
	}

	static fromSessionManager(sessionManager: SessionManager, options: MultiAgentStoreOptions = {}): MultiAgentStore {
		const store = new MultiAgentStore(options);
		store.restoreFromSessionManager(sessionManager);
		return store;
	}

	private restoreState(state: MultiAgentPersistedState | undefined): void {
		this.agents.clear();
		this.mailboxMessages.clear();
		this.abortHandlers.clear();
		this.lifecycleNotificationListeners.clear();
		this.transitionListeners.clear();
		this.selectedAgentId = undefined;
		this.nextAgentNumber = state?.counters.nextAgentNumber ?? 1;
		this.nextMessageNumber = state?.counters.nextMessageNumber ?? 1;
		if (!state) {
			return;
		}

		for (const agent of state.agents as AgentSnapshot[]) {
			const restored = this.restoreAgentSnapshot(agent);
			this.agents.set(agent.id, restored.agent);
		}
		for (const message of state.mailboxMessages as AgentMailboxMessage[]) {
			this.mailboxMessages.set(message.id, copyMessage(message));
		}
	}

	private restoreAgentSnapshot(agent: AgentSnapshot): { agent: AgentNode; corrected: boolean } {
		const restored = copyAgent(agent);
		// The last written lifecycle is the truth: restore never rewrites state. Worker
		// handles are runtime metadata and cannot survive the process, so they are cleared.
		if (!isActiveLifecycle(restored.lifecycle) || restored.worker === undefined) {
			return { agent: restored, corrected: false };
		}
		return { agent: { ...restored, worker: undefined }, corrected: true };
	}

	private putMailboxMessage(message: AgentMailboxMessage): void {
		this.mailboxMessages.set(message.id, message);
		if (!this.persistence) {
			return;
		}
		upsertMultiAgentMailboxMessage(this.persistence.controlDbPath, this.persistence.sessionPath, message.id, message);
	}

	private listSlotProjections(): AgentSlotProjection[] {
		return Array.from(this.agents.values())
			.filter((agent): agent is AgentNode & { slot: NonNullable<AgentNode["slot"]> } => agent.slot !== undefined)
			.map((agent) => ({
				agentId: agent.id,
				agent: copyAgent(agent),
				index: agent.slot.index,
				pinned: agent.slot.pinned,
				revision: agent.revision,
			}))
			.sort((left, right) => left.index - right.index || left.agentId.localeCompare(right.agentId));
	}

	private listRowProjections(): AgentRowProjection[] {
		return Array.from(this.agents.values()).map((agent) => ({
			active: isActiveLifecycle(agent.lifecycle),
			agentId: agent.id,
			displayName: agent.displayName,
			lifecycle: agent.lifecycle,
			revision: agent.revision,
			selected: this.selectedAgentId === agent.id,
			slotIndex: agent.slot?.index,
			workerAdapter: agent.worker?.adapter,
		}));
	}

	private findAgentForSlotSelection(slotIndex: number): AgentNode | undefined {
		const pinnedAgent = this.findActiveAgentByPinnedSlot(slotIndex);
		return pinnedAgent ?? this.listActiveAgentNodes()[slotIndex - 1];
	}

	private findActiveAgentByPinnedSlot(slotIndex: number): AgentNode | undefined {
		for (const agent of this.agents.values()) {
			if (agent.slot?.index === slotIndex && isActiveLifecycle(agent.lifecycle)) {
				return agent;
			}
		}

		return undefined;
	}

	private listActiveAgentNodes(): AgentNode[] {
		return Array.from(this.agents.values()).filter((agent) => isActiveLifecycle(agent.lifecycle));
	}

	private findSlotOccupant(slotIndex: number, excludedAgentId: string): AgentNode | undefined {
		for (const agent of this.agents.values()) {
			if (agent.id !== excludedAgentId && agent.slot?.index === slotIndex) {
				return agent;
			}
		}

		return undefined;
	}

	private canSendDirectMessage(fromAgentId: string, toAgentId: string): boolean {
		return this.isAncestor(fromAgentId, toAgentId) || this.isAncestor(toAgentId, fromAgentId);
	}

	private isMainThreadChild(agent: AgentNode): boolean {
		return (agent.parentId ?? MAIN_THREAD_AGENT_ID) === MAIN_THREAD_AGENT_ID;
	}

	private createMainThreadSnapshot(): AgentSnapshot {
		const timestamp = this.now();
		return {
			agentType: "main",
			createdAt: timestamp,
			cwd: "",
			displayName: "Main thread",
			id: MAIN_THREAD_AGENT_ID,
			lifecycle: "running",
			parentId: undefined,
			permission: { narrowed: true, policy: "on-request" },
			revision: 0,
			updatedAt: timestamp,
		};
	}

	private isAncestor(ancestorId: string, descendantId: string): boolean {
		let current = this.agents.get(descendantId);
		while (current?.parentId) {
			if (current.parentId === ancestorId) {
				return true;
			}
			current = this.agents.get(current.parentId);
		}

		return false;
	}

	private checkRevision(
		current: AgentNode,
		expectedRevision: number,
	): Extract<AgentCommandResult, { ok: false; error: "stale_revision" }> | undefined {
		if (current.revision === expectedRevision) {
			return undefined;
		}

		return { ok: false, error: "stale_revision", current: copyAgent(current) };
	}

	private persistAgentMetadata(
		current: AgentNode,
		updates: Partial<Pick<AgentNode, "currentActivity" | "lastActivity" | "slot" | "transcript">>,
		updatedAt: string,
		activityOwnership?: AgentCurrentActivityOwner,
	): AgentNode | undefined {
		if (!this.persistence) {
			return undefined;
		}
		const { controlDbPath, sessionPath } = this.persistence;
		if ("currentActivity" in updates) {
			if (!activityOwnership) {
				throw new Error(`Persisted agent ${current.id} activity update requires exact runtime ownership`);
			}
			return updateMultiAgentAgentCurrentActivity(
				controlDbPath,
				sessionPath,
				current.id,
				updates.currentActivity,
				updatedAt,
				activityOwnership,
			);
		}
		if ("transcript" in updates) {
			return updateMultiAgentAgentTranscript(controlDbPath, sessionPath, current.id, updates.transcript, updatedAt);
		}
		if ("slot" in updates) {
			return updateMultiAgentAgentSlot(controlDbPath, sessionPath, current.id, updates.slot, updatedAt);
		}
		return updateMultiAgentAgentActivity(controlDbPath, sessionPath, current.id, updates.lastActivity, updatedAt);
	}

	private updateAgentMetadata(
		current: AgentNode,
		updates: Partial<Pick<AgentNode, "currentActivity" | "lastActivity" | "slot" | "transcript">>,
		activityOwnership?: AgentCurrentActivityOwner,
	): AgentNode {
		const updatedAt = this.now();
		const persisted = this.persistAgentMetadata(current, updates, updatedAt, activityOwnership);
		if (this.persistence && !persisted) {
			throw new Error(`Persisted agent ${current.id} metadata update was rejected`);
		}
		const updated = persisted ?? { ...current, ...updates, updatedAt };
		this.agents.set(updated.id, updated);
		this.notifyAgentUpdateListeners(current, updated);

		return updated;
	}

	private retryOrRecordTerminalNotification(
		agent: AgentNode,
		lifecycle: Extract<AgentLifecycleNotificationLifecycle, "completed" | "failed">,
	): void {
		const existing = this.listPendingLifecycleNotificationsForAgent(agent.id, lifecycle)[0];
		if (existing) {
			this.notifyLifecycleNotificationListeners(existing);
			return;
		}
		if (lifecycle === "completed") {
			this.recordCompletionNotification(agent);
			return;
		}
		this.recordFailureNotification(agent);
	}

	private recordCompletionNotification(agent: AgentNode): void {
		if (this.hasPendingLifecycleNotification(agent.id, "completed")) {
			return;
		}

		this.recordLifecycleNotification(agent, {
			body: formatCompletionNotificationBody(agent),
			fileRefs: copyFileRefs(agent.result?.fileRefs),
			threadId: completionNotificationThreadId(agent.id),
		});
	}

	private recordFailureNotification(agent: AgentNode): void {
		if (this.hasPendingLifecycleNotification(agent.id, "failed")) {
			return;
		}

		this.recordLifecycleNotification(agent, {
			body: formatFailureNotificationBody(agent),
			fileRefs: copyFileRefs(agent.result?.fileRefs),
			threadId: failedNotificationThreadId(agent.id),
		});
	}

	private recordWaitingForInputNotification(agent: AgentNode): void {
		if (this.hasPendingLifecycleNotification(agent.id, "waiting_for_input")) {
			return;
		}

		this.recordLifecycleNotification(agent, {
			body: formatWaitingForInputNotificationBody(agent),
			threadId: waitingForInputNotificationThreadId(agent.id),
		});
	}

	private recordLifecycleNotification(agent: AgentNode, input: AgentLifecycleNotificationInput): void {
		const timestamp = this.now();
		const message: AgentMailboxMessage = {
			body: input.body,
			createdAt: timestamp,
			fromAgentId: agent.id,
			id: this.createMessageId(),
			kind: "system",
			status: "pending",
			threadId: input.threadId,
			toAgentId: agent.parentId ?? MAIN_THREAD_AGENT_ID,
			updatedAt: timestamp,
			fileRefs: validateFileRefs(input.fileRefs, "lifecycle_notification"),
		};
		this.putMailboxMessage(message);
		this.notifyLifecycleNotificationListeners(message);
	}

	private notifyLifecycleNotificationListeners(message: AgentMailboxMessage): void {
		const snapshot = copyMessage(message);
		for (const listener of this.lifecycleNotificationListeners) {
			listener(snapshot);
		}
	}

	private notifyTransitionListenersIfLifecycleChanged(previous: AgentNode, current: AgentNode): void {
		if (previous.lifecycle !== current.lifecycle) {
			this.notifyTransitionListeners(previous, current);
		}
	}

	private notifyTransitionListeners(previous: AgentNode, current: AgentNode): void {
		const previousSnapshot = copyAgent(previous);
		const currentSnapshot = copyAgent(current);
		for (const listener of this.transitionListeners) {
			listener(previousSnapshot, currentSnapshot);
		}
	}

	private notifyAgentUpdateListeners(previous: AgentNode, current: AgentNode): void {
		const previousSnapshot = copyAgent(previous);
		const currentSnapshot = copyAgent(current);
		for (const listener of this.updateListeners) {
			try {
				listener(previousSnapshot, currentSnapshot);
			} catch (error) {
				console.error("MultiAgentStore agent update listener failed:", error);
			}
		}
	}

	private hasPendingLifecycleNotification(agentId: string, lifecycle: AgentLifecycleNotificationLifecycle): boolean {
		for (const message of this.mailboxMessages.values()) {
			if (isPendingLifecycleNotification(message, agentId, lifecycle)) {
				return true;
			}
		}

		return false;
	}

	private createAgentId(prefix: "agent" | "bash" | "pyrun" = "agent"): string {
		const allocated = this.allocateCounter("agent", this.nextAgentNumber);
		return `${prefix}_${allocated}`;
	}

	private createMessageId(): string {
		const allocated = this.allocateCounter("message", this.nextMessageNumber);
		return `message_${allocated}`;
	}

	private allocateCounter(counterName: "agent" | "message", currentValue: number): number {
		if (this.persistence) {
			const allocated = allocateMultiAgentCounter(
				this.persistence.controlDbPath,
				this.persistence.sessionPath,
				counterName,
			);
			this.updateLocalCounter(counterName, allocated + 1);
			return allocated;
		}

		this.updateLocalCounter(counterName, currentValue + 1);
		return currentValue;
	}

	private updateLocalCounter(counterName: "agent" | "message", nextValue: number): void {
		if (counterName === "agent") {
			this.nextAgentNumber = nextValue;
		} else {
			this.nextMessageNumber = nextValue;
		}
	}
}

export function isActiveLifecycle(lifecycle: AgentLifecycleState): boolean {
	return !TERMINAL_STATES.has(lifecycle);
}

export function formatInactiveAgentSelectionMessage(agent: Pick<AgentSnapshot, "displayName" | "lifecycle">): string {
	return `Agent is not active: ${agent.displayName} (${agent.lifecycle})`;
}

function completionNotificationThreadId(agentId: string): string {
	return `${COMPLETION_NOTIFICATION_THREAD_PREFIX}:${agentId}`;
}

function failedNotificationThreadId(agentId: string): string {
	return `${FAILED_NOTIFICATION_THREAD_PREFIX}:${agentId}`;
}

function waitingForInputNotificationThreadId(agentId: string): string {
	return `${WAITING_FOR_INPUT_NOTIFICATION_THREAD_PREFIX}:${agentId}`;
}

function isPendingLifecycleNotification(
	message: AgentMailboxMessage,
	agentId: string,
	lifecycle: AgentLifecycleNotificationLifecycle,
): boolean {
	const isFromAgent = message.fromAgentId === agentId;
	const isLifecycleNotice =
		message.kind === "system" && message.threadId === lifecycleNotificationThreadId(agentId, lifecycle);
	return isFromAgent && isLifecycleNotice && message.status === "pending";
}

function lifecycleNotificationThreadId(agentId: string, lifecycle: AgentLifecycleNotificationLifecycle): string {
	switch (lifecycle) {
		case "completed":
			return completionNotificationThreadId(agentId);
		case "failed":
			return failedNotificationThreadId(agentId);
		case "waiting_for_input":
			return waitingForInputNotificationThreadId(agentId);
	}
}

function formatCompletionNotificationBody(agent: AgentNode): string {
	const summary = agent.result?.summary?.trim();
	const body = summary ? `${agent.displayName} completed: ${summary}` : `${agent.displayName} completed.`;
	return appendAgentDuration(body, agent.result?.durationMs);
}

function formatFailureNotificationBody(agent: AgentNode): string {
	const errorMessage = agent.error?.message.trim();
	const body = errorMessage ? `${agent.displayName} failed: ${errorMessage}` : `${agent.displayName} failed.`;
	return appendAgentDuration(body, agent.result?.durationMs);
}

function appendAgentDuration(body: string, durationMs: number | undefined): string {
	if (durationMs === undefined) {
		return body;
	}
	const separator = /[.!?]$/.test(body) ? " " : ". ";
	return `${body}${separator}Duration: ${durationMs}ms`;
}

function formatWaitingForInputNotificationBody(agent: AgentNode): string {
	return `${agent.displayName} is waiting for input.`;
}

function copyAgent(agent: AgentNode): AgentSnapshot {
	return {
		...agent,
		account: copyAccount(agent.account),
		error: copyOptional(agent.error),
		currentActivity: copyOptional(agent.currentActivity),
		lastActivity: copyOptional(agent.lastActivity),
		model: copyOptional(agent.model),
		permission: { ...agent.permission },
		result: copyResult(agent.result),
		slot: copyOptional(agent.slot),
		eventStream: copyEventStream(agent.eventStream),
		transcript: copyTranscript(agent.transcript),
		worker: copyWorker(agent.worker),
		worktree: copyWorktree(agent.worktree),
	};
}

function copyMessage(message: AgentMailboxMessage): AgentMailboxMessage {
	return {
		body: message.body,
		createdAt: message.createdAt,
		error: message.error,
		fileRefs: copyFileRefs(message.fileRefs),
		fromAgentId: message.fromAgentId,
		id: message.id,
		kind: message.kind,
		status: message.status,
		targetCheckpoint: message.targetCheckpoint,
		threadId: message.threadId,
		toAgentId: message.toAgentId,
		updatedAt: message.updatedAt,
	};
}

function copyAccount(account: AgentNode["account"] | undefined): AgentNode["account"] | undefined {
	if (!account) {
		return undefined;
	}
	return {
		budgetId: account.budgetId,
		concurrencyCap: account.concurrencyCap,
		id: account.id,
		providerFallback: account.providerFallback ? [...account.providerFallback] : undefined,
		rateLimit: account.rateLimit ? { ...account.rateLimit } : undefined,
		tokenBudget: account.tokenBudget ? { ...account.tokenBudget } : undefined,
	};
}

function copyWorker(worker: AgentWorkerAdapter | undefined): AgentWorkerAdapter | undefined {
	if (!worker) {
		return undefined;
	}
	validateOptionalPath(worker.cwd, "agent_worker.cwd");
	return {
		adapter: worker.adapter,
		cwd: worker.cwd,
		handleId: worker.handleId,
		toolCallId: worker.toolCallId,
	};
}

function copyTranscript(transcript: AgentTranscriptMetadata | undefined): AgentTranscriptMetadata | undefined {
	if (!transcript) {
		return undefined;
	}
	validateOptionalPath(transcript.path, "agent_transcript.path");
	return {
		path: transcript.path,
		sessionId: transcript.sessionId,
	};
}

function copyEventStream(eventStream: AgentEventStreamMetadata | undefined): AgentEventStreamMetadata | undefined {
	if (!eventStream) {
		return undefined;
	}
	validateAbsolutePath(eventStream.path, "agent_event_stream.path");
	return {
		byteLimit: eventStream.byteLimit,
		eventCount: eventStream.eventCount,
		path: eventStream.path,
		truncated: eventStream.truncated,
	};
}

function copyOptional<T extends object>(value: T | undefined): T | undefined {
	return value ? { ...value } : undefined;
}

function copyWorktree(worktree: AgentNode["worktree"]): AgentNode["worktree"] {
	if (!worktree) {
		return undefined;
	}
	validateAbsolutePath(worktree.path, "agent_worktree.path");
	return { ...worktree };
}

function validateAbsolutePath(path: string, context: string): void {
	if (!isAbsolute(path)) {
		throw new Error(`Invalid path at ${context}: expected an absolute path, received ${path}`);
	}
}

function validateOptionalPath(path: string | undefined, context: string): void {
	if (path !== undefined) {
		validateAbsolutePath(path, context);
	}
}

function copyFileRefs(refs: AgentFileReference[] | undefined): AgentFileReference[] | undefined {
	return validateFileRefs(refs, "file_reference_copy");
}

function validateFileRefs(refs: AgentFileReference[] | undefined, context: string): AgentFileReference[] | undefined {
	if (!refs) {
		return undefined;
	}
	return refs.map((ref, index) => {
		if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
			throw new Error(`Invalid file reference at ${context}[${index}]`);
		}
		if (typeof ref.path !== "string" || !isAbsolute(ref.path)) {
			const path = typeof ref.path === "string" ? ref.path : String(ref.path);
			throw new Error(`Invalid file reference at ${context}[${index}]: path must be absolute, received ${path}`);
		}
		if (ref.label !== undefined && typeof ref.label !== "string") {
			throw new Error(`Invalid file reference at ${context}[${index}]: label must be a string`);
		}
		return { path: ref.path, label: ref.label };
	});
}

function copyResult(result: AgentResult | undefined): AgentResult | undefined {
	if (!result) {
		return undefined;
	}
	return {
		durationMs: result.durationMs,
		fileRefs: validateFileRefs(result.fileRefs, "agent_result"),
		summary: result.summary,
		toolCallId: result.toolCallId,
	};
}
