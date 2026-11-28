import { isMailboxMessageExpired } from "./mailbox-retention.ts";
import {
	clearAgentSlot,
	clearSelectedAgentView,
	getActiveAgentCount,
	getAgent,
	getProjectionSnapshot,
	getSelectedAgentId,
	listActiveAgents,
	listAgents,
	listDescendants,
	pinAgentSlot,
	selectActiveAgentSlotTarget,
	selectActiveAgentSlotTargetWithStatus,
	selectActiveAgentTarget,
	selectActiveAgentTargetWithStatus,
	selectAgentSlot,
	selectAgentSlotWithStatus,
	selectAgentView,
	selectAgentViewWithStatus,
} from "./multi-agent-agent-selection.ts";
import {
	consumeCompletionNotificationsForAgent,
	consumeFailureNotificationsForAgent,
	contactParent,
	expireMailboxMessages,
	isActiveLifecycle,
	listMailboxMessages,
	listPendingLifecycleNotifications,
	listPendingLifecycleNotificationsForAgent,
	listPendingMailboxMessagesForAgent,
	markMailboxMessageDelivered,
	markMailboxMessageFailed,
	prepareSteeringMessageForLifecycleCoordinator,
	publishLifecycleCoordinatorSnapshot,
	publishLifecycleCoordinatorSteering,
	publishLifecycleCoordinatorSteeringDelivery,
	publishTerminalOutboxSnapshot,
	recordOutboundSessionMessage,
	sendMailboxMessage,
	sendMainThreadMailboxMessage,
} from "./multi-agent-mailbox-state.ts";
import type {
	ActiveAgentTargetSelectionResult,
	AgentCommandResult,
	AgentCurrentActivity,
	AgentCurrentActivityOwner,
	AgentFileReference,
	AgentLifecycleNotificationLifecycle,
	AgentLifecycleNotificationListener,
	AgentMailboxMessage,
	AgentMetadataCommandResult,
	AgentNode,
	AgentSnapshot,
	AgentTranscriptCommandResult,
	AgentTranscriptMetadata,
	AgentTransitionListener,
	AgentUpdateListener,
	AgentViewSelectionResult,
	ContactParentInput,
	MailboxMessageCommandResult,
	MultiAgentProjectionSnapshot,
	MultiAgentStoreOptions,
	ParentContactResult,
	PendingLifecycleNotification,
	SendMailboxMessageInput,
	SendSteeringInput,
} from "./multi-agent-types.ts";
import { MAIN_THREAD_AGENT_ID, TERMINAL_STATES } from "./multi-agent-types.ts";
import type { SessionManager } from "./session-manager.ts";

export type {
	ActiveAgentTargetSelectionResult,
	AgentActivity,
	AgentCommandResult,
	AgentCurrentActivity,
	AgentCurrentActivityOwner,
	AgentEventStreamMetadata,
	AgentFileReference,
	AgentLifecycleNotificationListener,
	AgentLifecycleState,
	AgentMailboxMessage,
	AgentMetadataCommandResult,
	AgentNode,
	AgentResult,
	AgentRowProjection,
	AgentSlotProjection,
	AgentSnapshot,
	AgentTranscriptCommandResult,
	AgentTranscriptMetadata,
	AgentTransitionListener,
	AgentUpdateListener,
	AgentViewSelectionResult,
	AgentWorkerAdapter,
	AttachSessionAgentInput,
	ContactParentInput,
	MailboxMessageCommandResult,
	MailboxMessageKind,
	MailboxMessageStatus,
	MultiAgentProjectionSnapshot,
	MultiAgentStoreOptions,
	ParentContactResult,
	PendingLifecycleNotification,
	SendMailboxMessageInput,
	SendSteeringInput,
	SpawnAgentInput,
	SpawnChildAgentInput,
	SpawnChildAgentResult,
	SteeringCheckpoint,
	TerminalAgentLifecycleState,
} from "./multi-agent-types.ts";

import { copyAgent, copyMessage, copyTranscript, validateOptionalPath } from "./multi-agent-snapshots.ts";
import {
	allocateMultiAgentCounter,
	type MultiAgentPersistedState,
	readMultiAgentState,
	updateMultiAgentAgentActivity,
	updateMultiAgentAgentCurrentActivity,
	updateMultiAgentAgentDisplayName,
	updateMultiAgentAgentModel,
	updateMultiAgentAgentSlot,
	updateMultiAgentAgentTranscript,
} from "./session-control-db.ts";

export class MultiAgentStore {
	/** @internal */
	readonly agents = new Map<string, AgentNode>();
	/** @internal */
	readonly mailboxMessages = new Map<string, AgentMailboxMessage>();
	/** @internal */
	readonly lifecycleNotificationListeners = new Set<AgentLifecycleNotificationListener>();
	private readonly transitionListeners = new Set<AgentTransitionListener>();
	private readonly updateListeners = new Set<AgentUpdateListener>();
	private readonly abortHandlers = new Map<string, () => void>();
	/** @internal */
	readonly now: () => string;
	private nextAgentNumber = 1;
	private nextMessageNumber = 1;
	private restoreGeneration = 0;
	/** @internal */
	persistence: { controlDbPath: string; sessionPath: string } | undefined;
	/** @internal */
	selectedAgentId: string | undefined;

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
		return prepareSteeringMessageForLifecycleCoordinator(this, agentId, input);
	}

	publishLifecycleCoordinatorSteering(agent: AgentSnapshot, message: AgentMailboxMessage): void {
		publishLifecycleCoordinatorSteering(this, agent, message);
	}

	publishLifecycleCoordinatorSteeringDelivery(agent: AgentSnapshot, message: AgentMailboxMessage): void {
		publishLifecycleCoordinatorSteeringDelivery(this, agent, message);
	}

	publishLifecycleCoordinatorSnapshot(agent: AgentSnapshot): void {
		publishLifecycleCoordinatorSnapshot(this, agent);
	}

	publishTerminalOutboxSnapshot(agent: AgentSnapshot): void {
		publishTerminalOutboxSnapshot(this, agent);
	}

	selectAgentView(agentId: string): AgentSnapshot | undefined {
		return selectAgentView(this, agentId);
	}

	selectAgentViewWithStatus(agentId: string): AgentViewSelectionResult {
		return selectAgentViewWithStatus(this, agentId);
	}

	selectActiveAgentTarget(agentId: string): AgentSnapshot | undefined {
		return selectActiveAgentTarget(this, agentId);
	}

	selectActiveAgentTargetWithStatus(agentId: string): ActiveAgentTargetSelectionResult {
		return selectActiveAgentTargetWithStatus(this, agentId);
	}

	selectAgentSlot(slotIndex: number): AgentSnapshot | undefined {
		return selectAgentSlot(this, slotIndex);
	}

	selectAgentSlotWithStatus(slotIndex: number): AgentViewSelectionResult {
		return selectAgentSlotWithStatus(this, slotIndex);
	}

	selectActiveAgentSlotTarget(slotIndex: number): AgentSnapshot | undefined {
		return selectActiveAgentSlotTarget(this, slotIndex);
	}

	selectActiveAgentSlotTargetWithStatus(slotIndex: number): ActiveAgentTargetSelectionResult {
		return selectActiveAgentSlotTargetWithStatus(this, slotIndex);
	}

	getSelectedAgentId(): string | undefined {
		return getSelectedAgentId(this);
	}

	clearSelectedAgentView(): void {
		clearSelectedAgentView(this);
	}

	/** @internal */
	clearSelectedTerminalAgent(agent: AgentSnapshot): void {
		if (this.selectedAgentId === agent.id && TERMINAL_STATES.has(agent.lifecycle)) {
			this.selectedAgentId = undefined;
		}
	}

	getAgent(agentId: string): AgentSnapshot | undefined {
		return getAgent(this, agentId);
	}

	listAgents(): AgentSnapshot[] {
		return listAgents(this);
	}

	listDescendants(parentId: string): AgentSnapshot[] {
		return listDescendants(this, parentId);
	}

	expireMailboxMessages(now: number): void {
		expireMailboxMessages(this, now);
	}

	listMailboxMessages(): AgentMailboxMessage[] {
		return listMailboxMessages(this);
	}

	listPendingMailboxMessagesForAgent(agentId: string): AgentMailboxMessage[] {
		return listPendingMailboxMessagesForAgent(this, agentId);
	}

	markMailboxMessageDelivered(messageId: string): AgentMailboxMessage | undefined {
		return markMailboxMessageDelivered(this, messageId);
	}

	markMailboxMessageFailed(messageId: string, error: string): AgentMailboxMessage | undefined {
		return markMailboxMessageFailed(this, messageId, error);
	}

	consumeCompletionNotificationsForAgent(agentId: string): AgentMailboxMessage[] {
		return consumeCompletionNotificationsForAgent(this, agentId);
	}

	consumeFailureNotificationsForAgent(agentId: string): AgentMailboxMessage[] {
		return consumeFailureNotificationsForAgent(this, agentId);
	}

	listPendingLifecycleNotificationsForAgent(
		agentId: string,
		lifecycle: AgentLifecycleNotificationLifecycle,
	): AgentMailboxMessage[] {
		return listPendingLifecycleNotificationsForAgent(this, agentId, lifecycle);
	}

	/** Pending lifecycle notifications in mailbox order, derived from mailbox rows instead of agent history. */
	listPendingLifecycleNotifications(): PendingLifecycleNotification[] {
		return listPendingLifecycleNotifications(this);
	}

	getProjectionSnapshot(): MultiAgentProjectionSnapshot {
		return getProjectionSnapshot(this);
	}

	listActiveAgents(): AgentSnapshot[] {
		return listActiveAgents(this);
	}

	getActiveAgentCount(): number {
		return getActiveAgentCount(this);
	}

	pinAgentSlot(agentId: string, expectedRevision: number, slotIndex: number): AgentMetadataCommandResult {
		return pinAgentSlot(this, agentId, expectedRevision, slotIndex);
	}

	publishAgentCurrentActivity(
		agentId: string,
		currentActivity: AgentCurrentActivity | undefined,
		ownership?: AgentCurrentActivityOwner,
		model?: NonNullable<AgentSnapshot["model"]>,
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

		return copyAgent(
			this.updateAgentMetadata(current, { currentActivity, ...(model ? { model: { ...model } } : {}) }, ownership),
		);
	}

	/** Records a child's effective model and effort; a child not yet admitted to the store has no record to update. */
	publishAgentModel(
		agentId: string,
		model: NonNullable<AgentSnapshot["model"]>,
		ownership?: AgentCurrentActivityOwner,
	): AgentSnapshot | undefined {
		const current = this.agents.get(agentId);
		if (!current) return undefined;
		return copyAgent(this.updateAgentMetadata(current, { model: { ...model } }, ownership));
	}

	renameAgent(agentId: string, displayName: string): AgentTranscriptCommandResult {
		if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(displayName) || !displayName.trim()) {
			throw new Error("Agent display name must be non-blank and contain no control or line separator characters");
		}
		const current = this.agents.get(agentId);
		if (!current) return { ok: false, error: "not_found", agentId };
		if (!this.persistence) throw new Error("Renaming an agent requires a persisted store");
		const updated = this.updateAgentMetadata(current, { displayName: displayName.trim() });
		return { ok: true, agent: copyAgent(updated) };
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
		return clearAgentSlot(this, agentId, expectedRevision);
	}

	contactParent(agentId: string, input: ContactParentInput): ParentContactResult {
		return contactParent(this, agentId, input);
	}

	sendMainThreadMailboxMessage(input: SendMailboxMessageInput): MailboxMessageCommandResult {
		return sendMainThreadMailboxMessage(this, input);
	}

	sendMailboxMessage(
		agentId: string,
		expectedRevision: number,
		input: SendMailboxMessageInput,
	): MailboxMessageCommandResult {
		return sendMailboxMessage(this, agentId, expectedRevision, input);
	}

	/** Record a message addressed to another session; the target is not an agent in this store. */
	recordOutboundSessionMessage(input: {
		fromAgentId: string;
		toAgentId: string;
		body: string;
		threadId?: string;
		fileRefs?: AgentFileReference[];
	}): AgentMailboxMessage {
		return recordOutboundSessionMessage(this, input);
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
			this.agents.set(agent.id, this.restoreAgentSnapshot(agent));
		}
		const now = Date.parse(this.now());
		for (const message of state.mailboxMessages as AgentMailboxMessage[]) {
			if (!isMailboxMessageExpired(message.createdAt, now)) {
				this.mailboxMessages.set(message.id, copyMessage(message));
			}
		}
	}

	private restoreAgentSnapshot(agent: AgentSnapshot): AgentNode {
		const restored = copyAgent(agent);
		// The last written lifecycle is the truth: restore never rewrites state. Worker
		// handles are runtime metadata and cannot survive the process, so they are cleared.
		if (!isActiveLifecycle(restored.lifecycle) || restored.worker === undefined) {
			return restored;
		}
		return { ...restored, worker: undefined };
	}

	/** @internal */
	canSendDirectMessage(fromAgentId: string, toAgentId: string): boolean {
		const sender = this.agents.get(fromAgentId);
		const recipient = this.agents.get(toAgentId);
		return sender?.parentId === toAgentId || recipient?.parentId === fromAgentId;
	}

	/** @internal */
	isMainThreadChild(agent: AgentNode): boolean {
		return (agent.parentId ?? MAIN_THREAD_AGENT_ID) === MAIN_THREAD_AGENT_ID;
	}

	/** @internal */
	createMainThreadSnapshot(): AgentSnapshot {
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

	/** @internal */
	checkRevision(
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
		updates: Partial<
			Pick<AgentNode, "currentActivity" | "displayName" | "lastActivity" | "model" | "slot" | "transcript">
		>,
		updatedAt: string,
		activityOwnership?: AgentCurrentActivityOwner,
	): AgentNode | undefined {
		if (!this.persistence) {
			return undefined;
		}
		const { controlDbPath, sessionPath } = this.persistence;
		if ("currentActivity" in updates || updates.model) {
			return this.persistOwnedAgentMetadata(current, updates, updatedAt, activityOwnership);
		}
		if ("displayName" in updates && updates.displayName !== undefined) {
			return updateMultiAgentAgentDisplayName(controlDbPath, sessionPath, current.id, updates.displayName);
		}
		if ("transcript" in updates) {
			return updateMultiAgentAgentTranscript(controlDbPath, sessionPath, current.id, updates.transcript, updatedAt);
		}
		if ("slot" in updates) {
			return updateMultiAgentAgentSlot(controlDbPath, sessionPath, current.id, updates.slot, updatedAt);
		}
		return updateMultiAgentAgentActivity(controlDbPath, sessionPath, current.id, updates.lastActivity, updatedAt);
	}

	private persistOwnedAgentMetadata(
		current: AgentNode,
		updates: Partial<Pick<AgentNode, "currentActivity" | "model">>,
		updatedAt: string,
		owner?: AgentCurrentActivityOwner,
	): AgentNode | undefined {
		if (!this.persistence) return undefined;
		const { controlDbPath: dbPath, sessionPath } = this.persistence;
		const isActivity = "currentActivity" in updates;
		const kind = isActivity ? "activity" : "model metadata";
		if (!owner) throw new Error(`Persisted agent ${current.id} ${kind} update requires exact runtime ownership`);
		if (isActivity) {
			return updateMultiAgentAgentCurrentActivity(
				dbPath,
				sessionPath,
				current.id,
				updates.currentActivity,
				updatedAt,
				owner,
				updates.model,
			);
		}
		if (!updates.model) return undefined;
		return updateMultiAgentAgentModel(dbPath, sessionPath, current.id, updates.model, updatedAt, owner);
	}

	/** @internal */
	updateAgentMetadata(
		current: AgentNode,
		updates: Partial<
			Pick<AgentNode, "currentActivity" | "displayName" | "lastActivity" | "model" | "slot" | "transcript">
		>,
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

	/** @internal */
	notifyTransitionListenersIfLifecycleChanged(previous: AgentNode, current: AgentNode): void {
		if (previous.lifecycle !== current.lifecycle) {
			this.notifyTransitionListeners(previous, current);
		}
	}

	private notifyTransitionListeners(previous: AgentNode, current: AgentNode): void {
		const previousSnapshot = copyAgent(previous);
		const currentSnapshot = copyAgent(current);
		for (const listener of this.transitionListeners) {
			try {
				listener(previousSnapshot, currentSnapshot);
			} catch (error) {
				console.error("MultiAgentStore transition listener failed:", error);
			}
		}
	}

	/** @internal */
	notifyAgentUpdateListeners(previous: AgentNode | undefined, current: AgentNode): void {
		const previousSnapshot = previous && copyAgent(previous);
		const currentSnapshot = copyAgent(current);
		for (const listener of this.updateListeners) {
			try {
				listener(previousSnapshot, currentSnapshot);
			} catch (error) {
				console.error("MultiAgentStore agent update listener failed:", error);
			}
		}
	}

	private createAgentId(prefix: "agent" | "bash" | "pyrun" = "agent"): string {
		const allocated = this.allocateCounter("agent", this.nextAgentNumber);
		return `${prefix}_${allocated}`;
	}

	/** @internal */
	createMessageId(): string {
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

export { isActiveLifecycle };

export function formatInactiveAgentSelectionMessage(agent: Pick<AgentSnapshot, "displayName" | "lifecycle">): string {
	return `Agent is not active: ${agent.displayName} (${agent.lifecycle})`;
}
