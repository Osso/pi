import { isMailboxMessageExpired } from "./mailbox-retention.ts";
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
	AgentRowProjection,
	AgentSlotProjection,
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

	/** @internal */
	clearSelectedTerminalAgent(agent: AgentSnapshot): void {
		if (this.selectedAgentId === agent.id && TERMINAL_STATES.has(agent.lifecycle)) {
			this.selectedAgentId = undefined;
		}
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
	notifyAgentUpdateListeners(previous: AgentNode, current: AgentNode): void {
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
