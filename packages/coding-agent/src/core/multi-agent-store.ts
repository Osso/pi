import type { CustomEntry, SessionManager } from "./session-manager.ts";

export const MULTI_AGENT_EVENT_CUSTOM_TYPE = "multi_agent_event";

export type AgentLifecycleState =
	| "queued"
	| "starting"
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

export type MailboxMessageStatus = "pending" | "accepted" | "rejected" | "delivered" | "failed";

export interface AgentActivity {
	description: string;
	toolName?: string;
}

export interface AgentResult {
	summary?: string;
	artifactIds?: string[];
}

export interface AgentArtifactReference {
	id?: string;
	path?: string;
	label?: string;
}

export type AgentArtifactKind = "summary" | "diff" | "log" | "finding" | "transcript" | "file";

export interface AgentWorkerAdapter {
	adapter: "terminal" | "subprocess";
	handleId: string;
	cwd?: string;
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

export interface AgentArtifact {
	id: string;
	agentId: string;
	kind: AgentArtifactKind;
	title: string;
	path?: string;
	inlinePreview?: string;
	metadata?: Record<string, unknown>;
	createdAt: string;
}

export interface RecordAgentArtifactInput {
	agentId: string;
	kind: AgentArtifactKind;
	title: string;
	path?: string;
	inlinePreview?: string;
	metadata?: Record<string, unknown>;
}

export interface AgentNode {
	id: string;
	parentId: string | undefined;
	displayName: string;
	agentType: string;
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
	lastActivity?: AgentActivity;
	result?: AgentResult;
	error?: { message: string; code?: string };
}

export type AgentSnapshot = AgentNode;

export interface SpawnAgentInput {
	parentId?: string;
	displayName: string;
	agentType: string;
	cwd: string;
	permission: AgentNode["permission"];
	lifecycle?: "queued" | "starting";
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
	artifactIds?: string[];
	artifactRefs?: AgentArtifactReference[];
	targetCheckpoint?: SteeringCheckpoint;
	error?: string;
}

export interface SendSteeringInput {
	fromAgentId: string;
	body: string;
	targetCheckpoint?: SteeringCheckpoint;
	threadId?: string;
	artifactIds?: string[];
	artifactRefs?: AgentArtifactReference[];
}

export interface ContactSupervisorInput {
	body: string;
	threadId?: string;
	artifactIds?: string[];
	artifactRefs?: AgentArtifactReference[];
}

export interface SendMailboxMessageInput {
	body: string;
	toAgentId: string;
	threadId?: string;
	artifactIds?: string[];
	artifactRefs?: AgentArtifactReference[];
}

export interface TransitionAgentDetails {
	error?: AgentNode["error"];
	lastActivity?: AgentActivity;
	result?: AgentResult;
}

interface AgentLifecycleNotificationInput {
	artifactIds?: string[];
	body: string;
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

export type SteeringCommandResult =
	| { ok: true; agent: AgentSnapshot; message: AgentMailboxMessage }
	| { ok: false; error: "not_found"; agentId: string }
	| { ok: false; error: "stale_revision"; current: AgentSnapshot }
	| { ok: false; error: "message_not_found"; agent: AgentSnapshot; messageId: string }
	| { ok: false; error: "invalid_transition"; current: AgentSnapshot; requested: AgentLifecycleState };

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

export interface PersistedMultiAgentSnapshot {
	version: 1;
	kind: "snapshot";
	agents: AgentSnapshot[];
	artifacts: AgentArtifact[];
	mailboxMessages?: AgentMailboxMessage[];
	selectedAgentId?: string;
	nextAgentNumber: number;
	nextArtifactNumber: number;
	nextMessageNumber: number;
}

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
const WAITING_FOR_INPUT_NOTIFICATION_THREAD_PREFIX = "agent-waiting-for-input";
const MAIN_THREAD_AGENT_ID = "main";
const TERMINAL_STATES = new Set<AgentLifecycleState>(["completed", "failed", "aborted"]);

const ALLOWED_TRANSITIONS: ReadonlyMap<AgentLifecycleState, ReadonlySet<AgentLifecycleState>> = new Map([
	["queued", new Set(["starting", "aborted"])],
	["starting", new Set(["running", "failed", "aborted"])],
	["running", new Set(["waiting_for_input", "steering_pending", "cancelling", "completed", "failed", "aborted"])],
	["waiting_for_input", new Set(["running", "steering_pending", "cancelling", "completed", "aborted"])],
	["steering_pending", new Set(["running", "waiting_for_input", "cancelling", "failed", "aborted"])],
	["cancelling", new Set(["aborted", "failed", "completed"])],
	["completed", new Set()],
	["failed", new Set()],
	["aborted", new Set()],
]);

export class MultiAgentStore {
	private readonly agents = new Map<string, AgentNode>();
	private readonly artifacts = new Map<string, AgentArtifact>();
	private readonly mailboxMessages = new Map<string, AgentMailboxMessage>();
	private readonly lifecycleNotificationListeners = new Set<AgentLifecycleNotificationListener>();
	private readonly transitionListeners = new Set<AgentTransitionListener>();
	private readonly abortHandlers = new Map<string, () => void>();
	private readonly now: () => string;
	private nextAgentNumber = 1;
	private nextArtifactNumber = 1;
	private nextMessageNumber = 1;
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

	spawnAgent(input: SpawnAgentInput): { agent: AgentSnapshot } {
		const timestamp = this.now();
		const agent: AgentNode = {
			id: this.createAgentId(),
			parentId: input.parentId,
			displayName: input.displayName,
			agentType: input.agentType,
			lifecycle: input.lifecycle ?? "queued",
			revision: 1,
			createdAt: timestamp,
			updatedAt: timestamp,
			cwd: input.cwd,
			permission: { ...input.permission },
			account: copyAccount(input.account),
			model: copyOptional(input.model),
			slot: copyOptional(input.slot),
			eventStream: copyEventStream(input.eventStream),
			transcript: copyTranscript(input.transcript),
			worker: copyWorker(input.worker),
			worktree: copyOptional(input.worktree),
		};

		this.agents.set(agent.id, agent);

		return { agent: copyAgent(agent) };
	}

	spawnChildAgent(parentId: string, input: SpawnChildAgentInput): SpawnChildAgentResult {
		const parent = this.agents.get(parentId);
		if (!parent) {
			return { ok: false, error: "parent_not_found", parentId };
		}

		if (wouldBroadenPermission(parent.permission, input.permission)) {
			return { ok: false, error: "permission_broadened", parent: copyAgent(parent), requested: input.permission };
		}

		const spawned = this.spawnAgent({
			...input,
			account: copyAccount(input.account) ?? copyAccount(parent.account),
			model: copyOptional(input.model) ?? copyOptional(parent.model),
			parentId,
		});

		return { ok: true, agent: spawned.agent };
	}

	transitionAgent(
		agentId: string,
		expectedRevision: number,
		requested: AgentLifecycleState,
		details: TransitionAgentDetails = {},
	): AgentCommandResult {
		const current = this.agents.get(agentId);
		if (!current) {
			return { ok: false, error: "not_found", agentId };
		}

		const revisionCheck = this.checkRevision(current, expectedRevision);
		if (revisionCheck) {
			return revisionCheck;
		}

		if (!canTransition(current.lifecycle, requested)) {
			return { ok: false, error: "invalid_transition", current: copyAgent(current), requested };
		}

		const shouldNotifyCompletion = requested === "completed" && current.lifecycle !== "completed";
		const shouldNotifyWaitingForInput =
			requested === "waiting_for_input" && current.lifecycle !== "waiting_for_input";
		const updated = this.updateAgent(current, { ...details, lifecycle: requested });
		if (shouldNotifyCompletion) {
			this.recordCompletionNotification(updated);
		}
		if (shouldNotifyWaitingForInput) {
			this.recordWaitingForInputNotification(updated);
		}
		this.notifyTransitionListenersIfLifecycleChanged(current, updated);
		if (this.selectedAgentId === current.id && !isActiveLifecycle(updated.lifecycle)) {
			this.selectedAgentId = undefined;
		}
		return { ok: true, agent: copyAgent(updated) };
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
		const message = this.mailboxMessages.get(messageId);
		if (!message || message.status !== "pending") {
			return undefined;
		}

		const updated = { ...message, status: "delivered" as const, updatedAt: this.now() };
		this.mailboxMessages.set(updated.id, updated);
		return copyMessage(updated);
	}

	consumeCompletionNotificationsForAgent(agentId: string): void {
		for (const message of this.mailboxMessages.values()) {
			if (!isPendingCompletionNotification(message, agentId)) {
				continue;
			}
			const updated = { ...message, status: "delivered" as const, updatedAt: this.now() };
			this.mailboxMessages.set(updated.id, updated);
		}
	}

	listPendingLifecycleNotificationsForAgent(
		agentId: string,
		lifecycle: "completed" | "waiting_for_input",
	): AgentMailboxMessage[] {
		return Array.from(this.mailboxMessages.values())
			.filter((message) => isPendingLifecycleNotification(message, agentId, lifecycle))
			.map(copyMessage);
	}

	recordArtifact(input: RecordAgentArtifactInput): AgentArtifact {
		const artifact: AgentArtifact = {
			id: this.createArtifactId(),
			agentId: input.agentId,
			kind: input.kind,
			title: input.title,
			createdAt: this.now(),
			inlinePreview: input.inlinePreview,
			metadata: input.metadata ? { ...input.metadata } : undefined,
			path: input.path,
		};
		this.artifacts.set(artifact.id, artifact);

		return copyArtifact(artifact);
	}

	getArtifact(artifactId: string): AgentArtifact | undefined {
		const artifact = this.artifacts.get(artifactId);
		return artifact ? copyArtifact(artifact) : undefined;
	}

	listArtifacts(agentId?: string): AgentArtifact[] {
		const artifacts = Array.from(this.artifacts.values(), copyArtifact);
		return agentId ? artifacts.filter((artifact) => artifact.agentId === agentId) : artifacts;
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

		const updated = this.updateAgent(current, {
			slot: { index: slotIndex, pinned: true },
		});
		return { ok: true, agent: copyAgent(updated) };
	}

	updateAgentTranscript(agentId: string, transcript: AgentTranscriptMetadata): AgentTranscriptCommandResult {
		const current = this.agents.get(agentId);
		if (!current) {
			return { ok: false, error: "not_found", agentId };
		}

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

		const updated = this.updateAgent(current, {
			slot: undefined,
		});
		return { ok: true, agent: copyAgent(updated) };
	}

	contactSupervisor(
		agentId: string,
		expectedRevision: number,
		input: ContactSupervisorInput,
	): SupervisorContactResult {
		const current = this.agents.get(agentId);
		if (!current) {
			return { ok: false, error: "not_found", agentId };
		}

		const revisionCheck = this.checkRevision(current, expectedRevision);
		if (revisionCheck) {
			return revisionCheck;
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
			artifactIds: input.artifactIds ? [...input.artifactIds] : undefined,
			artifactRefs: copyArtifactRefs(input.artifactRefs),
		};
		this.mailboxMessages.set(message.id, message);

		const updated = this.updateAgent(current, {
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
			artifactIds: input.artifactIds ? [...input.artifactIds] : undefined,
			artifactRefs: copyArtifactRefs(input.artifactRefs),
		};
		this.mailboxMessages.set(message.id, message);

		const updated = this.updateAgent(target, {
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
			artifactIds: input.artifactIds ? [...input.artifactIds] : undefined,
			artifactRefs: copyArtifactRefs(input.artifactRefs),
		};
		this.mailboxMessages.set(message.id, message);

		const updated = this.updateAgent(current, {
			lastActivity: { description: "Sent mailbox message" },
		});

		return { ok: true, agent: copyAgent(updated), message: copyMessage(message) };
	}

	sendSteering(agentId: string, expectedRevision: number, input: SendSteeringInput): SteeringCommandResult {
		const current = this.agents.get(agentId);
		if (!current) {
			return { ok: false, error: "not_found", agentId };
		}

		const revisionCheck = this.checkRevision(current, expectedRevision);
		if (revisionCheck) {
			return revisionCheck;
		}

		if (!canTransition(current.lifecycle, "steering_pending") && current.lifecycle !== "steering_pending") {
			return { ok: false, error: "invalid_transition", current: copyAgent(current), requested: "steering_pending" };
		}

		const timestamp = this.now();
		const message: AgentMailboxMessage = {
			id: this.createMessageId(),
			threadId: input.threadId,
			fromAgentId: input.fromAgentId,
			toAgentId: agentId,
			kind: "steer",
			status: "pending",
			createdAt: timestamp,
			updatedAt: timestamp,
			body: input.body,
			artifactIds: input.artifactIds ? [...input.artifactIds] : undefined,
			artifactRefs: copyArtifactRefs(input.artifactRefs),
			targetCheckpoint: input.targetCheckpoint,
		};
		this.mailboxMessages.set(message.id, message);

		const updated = this.updateAgent(current, { lifecycle: "steering_pending" });
		this.notifyTransitionListenersIfLifecycleChanged(current, updated);

		return { ok: true, agent: copyAgent(updated), message: copyMessage(message) };
	}

	ackSteering(
		agentId: string,
		expectedRevision: number,
		messageId: string,
		status: Exclude<MailboxMessageStatus, "pending">,
	): SteeringCommandResult {
		const current = this.agents.get(agentId);
		if (!current) {
			return { ok: false, error: "not_found", agentId };
		}

		const revisionCheck = this.checkRevision(current, expectedRevision);
		if (revisionCheck) {
			return revisionCheck;
		}

		const message = this.mailboxMessages.get(messageId);
		if (!message || message.toAgentId !== agentId || message.kind !== "steer") {
			return { ok: false, error: "message_not_found", agent: copyAgent(current), messageId };
		}

		const updatedMessage = {
			...message,
			status,
			updatedAt: this.now(),
		};
		this.mailboxMessages.set(updatedMessage.id, updatedMessage);

		const nextLifecycle = status === "delivered" ? "running" : current.lifecycle;
		if (nextLifecycle !== current.lifecycle && !canTransition(current.lifecycle, nextLifecycle)) {
			return { ok: false, error: "invalid_transition", current: copyAgent(current), requested: nextLifecycle };
		}

		const updated = this.updateAgent(current, { lifecycle: nextLifecycle });
		this.notifyTransitionListenersIfLifecycleChanged(current, updated);

		return { ok: true, agent: copyAgent(updated), message: copyMessage(updatedMessage) };
	}

	toPersistedSnapshot(): PersistedMultiAgentSnapshot {
		return {
			version: 1,
			kind: "snapshot",
			agents: this.listAgents(),
			artifacts: this.listArtifacts(),
			mailboxMessages: this.listMailboxMessages(),
			selectedAgentId: this.selectedAgentId,
			nextAgentNumber: this.nextAgentNumber,
			nextArtifactNumber: this.nextArtifactNumber,
			nextMessageNumber: this.nextMessageNumber,
		};
	}

	persistSnapshot(sessionManager: SessionManager): string {
		return sessionManager.appendCustomEntry(MULTI_AGENT_EVENT_CUSTOM_TYPE, this.toPersistedSnapshot());
	}

	static fromSessionManager(sessionManager: SessionManager, options: MultiAgentStoreOptions = {}): MultiAgentStore {
		const store = new MultiAgentStore(options);
		const snapshot = findLatestPersistedSnapshot(sessionManager);
		if (!snapshot) {
			return store;
		}

		store.restoreSnapshot(snapshot);

		return store;
	}

	private restoreSnapshot(snapshot: PersistedMultiAgentSnapshot): void {
		this.agents.clear();
		this.artifacts.clear();
		this.mailboxMessages.clear();
		this.abortHandlers.clear();

		for (const agent of snapshot.agents) {
			this.agents.set(agent.id, copyAgent(agent));
		}

		for (const artifact of snapshot.artifacts ?? []) {
			this.artifacts.set(artifact.id, copyArtifact(artifact));
		}

		for (const message of snapshot.mailboxMessages ?? []) {
			this.mailboxMessages.set(message.id, copyMessage(message));
		}

		this.selectedAgentId = this.findRestoredSelectedAgentId(snapshot.selectedAgentId);
		this.nextAgentNumber = snapshot.nextAgentNumber;
		this.nextArtifactNumber = snapshot.nextArtifactNumber ?? 1;
		this.nextMessageNumber = snapshot.nextMessageNumber;
	}

	private findRestoredSelectedAgentId(selectedAgentId: string | undefined): string | undefined {
		if (!selectedAgentId) {
			return undefined;
		}
		return this.agents.has(selectedAgentId) ? selectedAgentId : undefined;
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

	private updateAgent(
		current: AgentNode,
		updates: TransitionAgentDetails & Partial<Pick<AgentNode, "lifecycle" | "slot">>,
	): AgentNode {
		const updated = {
			...current,
			...updates,
			revision: current.revision + 1,
			updatedAt: this.now(),
		};
		this.agents.set(updated.id, updated);

		return updated;
	}

	private updateAgentMetadata(current: AgentNode, updates: Partial<Pick<AgentNode, "transcript">>): AgentNode {
		const updated = {
			...current,
			...updates,
			updatedAt: this.now(),
		};
		this.agents.set(updated.id, updated);

		return updated;
	}

	private recordCompletionNotification(agent: AgentNode): void {
		if (this.hasPendingLifecycleNotification(agent.id, "completed")) {
			return;
		}

		const artifactIds = agent.result?.artifactIds;
		this.recordLifecycleNotification(agent, {
			artifactIds: artifactIds ? [...artifactIds] : undefined,
			body: formatCompletionNotificationBody(agent),
			threadId: completionNotificationThreadId(agent.id),
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
			artifactIds: input.artifactIds,
			body: input.body,
			createdAt: timestamp,
			fromAgentId: agent.id,
			id: this.createMessageId(),
			kind: "system",
			status: "pending",
			threadId: input.threadId,
			toAgentId: agent.parentId ?? MAIN_THREAD_AGENT_ID,
			updatedAt: timestamp,
		};
		this.mailboxMessages.set(message.id, message);
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

	private hasPendingLifecycleNotification(agentId: string, lifecycle: "completed" | "waiting_for_input"): boolean {
		for (const message of this.mailboxMessages.values()) {
			if (isPendingLifecycleNotification(message, agentId, lifecycle)) {
				return true;
			}
		}

		return false;
	}

	private createAgentId(): string {
		const id = `agent_${this.nextAgentNumber}`;
		this.nextAgentNumber += 1;

		return id;
	}

	private createArtifactId(): string {
		const id = `artifact_${this.nextArtifactNumber}`;
		this.nextArtifactNumber += 1;

		return id;
	}

	private createMessageId(): string {
		const id = `message_${this.nextMessageNumber}`;
		this.nextMessageNumber += 1;

		return id;
	}
}

export function isActiveLifecycle(lifecycle: AgentLifecycleState): boolean {
	return !TERMINAL_STATES.has(lifecycle);
}

export function formatInactiveAgentSelectionMessage(agent: Pick<AgentSnapshot, "displayName" | "lifecycle">): string {
	return `Agent is not active: ${agent.displayName} (${agent.lifecycle})`;
}

function canTransition(from: AgentLifecycleState, to: AgentLifecycleState): boolean {
	if (from === to && !TERMINAL_STATES.has(from)) {
		return true;
	}

	return ALLOWED_TRANSITIONS.get(from)?.has(to) ?? false;
}

function completionNotificationThreadId(agentId: string): string {
	return `${COMPLETION_NOTIFICATION_THREAD_PREFIX}:${agentId}`;
}

function waitingForInputNotificationThreadId(agentId: string): string {
	return `${WAITING_FOR_INPUT_NOTIFICATION_THREAD_PREFIX}:${agentId}`;
}

function isPendingCompletionNotification(message: AgentMailboxMessage, agentId: string): boolean {
	return isPendingLifecycleNotification(message, agentId, "completed");
}

function isPendingLifecycleNotification(
	message: AgentMailboxMessage,
	agentId: string,
	lifecycle: "completed" | "waiting_for_input",
): boolean {
	const isFromAgent = message.fromAgentId === agentId;
	const isLifecycleNotice =
		message.kind === "system" && message.threadId === lifecycleNotificationThreadId(agentId, lifecycle);
	return isFromAgent && isLifecycleNotice && message.status === "pending";
}

function lifecycleNotificationThreadId(agentId: string, lifecycle: "completed" | "waiting_for_input"): string {
	return lifecycle === "completed"
		? completionNotificationThreadId(agentId)
		: waitingForInputNotificationThreadId(agentId);
}

function formatCompletionNotificationBody(agent: AgentNode): string {
	const summary = agent.result?.summary?.trim();
	return summary ? `${agent.displayName} completed: ${summary}` : `${agent.displayName} completed.`;
}

function formatWaitingForInputNotificationBody(agent: AgentNode): string {
	return `${agent.displayName} is waiting for input.`;
}

function wouldBroadenPermission(parent: AgentNode["permission"], requested: AgentNode["permission"]): boolean {
	if (!requested.narrowed) {
		return true;
	}

	if (requested.policy !== parent.policy) {
		return true;
	}

	return false;
}

function copyAgent(agent: AgentNode): AgentSnapshot {
	return {
		...agent,
		account: copyAccount(agent.account),
		error: copyOptional(agent.error),
		lastActivity: copyOptional(agent.lastActivity),
		model: copyOptional(agent.model),
		permission: { ...agent.permission },
		result: copyResult(agent.result),
		slot: copyOptional(agent.slot),
		eventStream: copyEventStream(agent.eventStream),
		transcript: copyTranscript(agent.transcript),
		worker: copyWorker(agent.worker),
		worktree: copyOptional(agent.worktree),
	};
}

function copyMessage(message: AgentMailboxMessage): AgentMailboxMessage {
	return {
		...message,
		artifactIds: message.artifactIds ? [...message.artifactIds] : undefined,
		artifactRefs: copyArtifactRefs(message.artifactRefs),
	};
}

function copyArtifact(artifact: AgentArtifact): AgentArtifact {
	return {
		...artifact,
		metadata: artifact.metadata ? { ...artifact.metadata } : undefined,
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
	return {
		adapter: worker.adapter,
		cwd: worker.cwd,
		handleId: worker.handleId,
	};
}

function copyTranscript(transcript: AgentTranscriptMetadata | undefined): AgentTranscriptMetadata | undefined {
	if (!transcript) {
		return undefined;
	}
	return {
		path: transcript.path,
		sessionId: transcript.sessionId,
	};
}

function copyEventStream(eventStream: AgentEventStreamMetadata | undefined): AgentEventStreamMetadata | undefined {
	if (!eventStream) {
		return undefined;
	}
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

function copyArtifactRefs(refs: AgentArtifactReference[] | undefined): AgentArtifactReference[] | undefined {
	return refs?.map((ref) => ({
		id: ref.id,
		label: ref.label,
		path: ref.path,
	}));
}

function copyResult(result: AgentResult | undefined): AgentResult | undefined {
	return result
		? {
				...result,
				artifactIds: result.artifactIds ? [...result.artifactIds] : undefined,
			}
		: undefined;
}

function findLatestPersistedSnapshot(sessionManager: SessionManager): PersistedMultiAgentSnapshot | undefined {
	const entries = sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (isMultiAgentSnapshotEntry(entry)) {
			return entry.data;
		}
	}

	return undefined;
}

function isMultiAgentSnapshotEntry(entry: unknown): entry is CustomEntry<PersistedMultiAgentSnapshot> {
	if (!entry || typeof entry !== "object") {
		return false;
	}

	const customEntry = entry as CustomEntry;
	return (
		customEntry.type === "custom" &&
		customEntry.customType === MULTI_AGENT_EVENT_CUSTOM_TYPE &&
		isSnapshotData(customEntry.data)
	);
}

function isSnapshotData(data: unknown): data is PersistedMultiAgentSnapshot {
	if (!data || typeof data !== "object") {
		return false;
	}

	const snapshot = data as PersistedMultiAgentSnapshot;
	return (
		snapshot.version === 1 &&
		snapshot.kind === "snapshot" &&
		Array.isArray(snapshot.agents) &&
		(snapshot.artifacts === undefined || Array.isArray(snapshot.artifacts)) &&
		(snapshot.mailboxMessages === undefined || Array.isArray(snapshot.mailboxMessages)) &&
		typeof snapshot.nextAgentNumber === "number" &&
		(snapshot.nextArtifactNumber === undefined || typeof snapshot.nextArtifactNumber === "number") &&
		typeof snapshot.nextMessageNumber === "number"
	);
}
