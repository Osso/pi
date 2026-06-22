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
	account?: { id: string; budgetId?: string };
	permission: { policy: string; inheritedFrom?: string; narrowed: boolean };
	slot?: { index: number; pinned: boolean };
	transcript?: { sessionId: string; path?: string };
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
}

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
	targetCheckpoint?: SteeringCheckpoint;
	error?: string;
}

export interface SendSteeringInput {
	fromAgentId: string;
	body: string;
	targetCheckpoint?: SteeringCheckpoint;
	threadId?: string;
	artifactIds?: string[];
}

export type AgentCommandResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: "not_found"; agentId: string }
	| { ok: false; error: "stale_revision"; current: AgentSnapshot }
	| { ok: false; error: "invalid_transition"; current: AgentSnapshot; requested: AgentLifecycleState };

export type SteeringCommandResult =
	| { ok: true; agent: AgentSnapshot; message: AgentMailboxMessage }
	| { ok: false; error: "not_found"; agentId: string }
	| { ok: false; error: "stale_revision"; current: AgentSnapshot }
	| { ok: false; error: "message_not_found"; agent: AgentSnapshot; messageId: string }
	| { ok: false; error: "invalid_transition"; current: AgentSnapshot; requested: AgentLifecycleState };

export interface MultiAgentStoreOptions {
	now?: () => string;
}

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
	private readonly mailboxMessages = new Map<string, AgentMailboxMessage>();
	private readonly now: () => string;
	private nextAgentNumber = 1;
	private nextMessageNumber = 1;
	private selectedAgentId: string | undefined;

	constructor(options: MultiAgentStoreOptions = {}) {
		this.now = options.now ?? (() => new Date().toISOString());
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
			account: copyOptional(input.account),
			model: copyOptional(input.model),
			slot: copyOptional(input.slot),
			transcript: copyOptional(input.transcript),
			worktree: copyOptional(input.worktree),
		};

		this.agents.set(agent.id, agent);

		return { agent: copyAgent(agent) };
	}

	transitionAgent(agentId: string, expectedRevision: number, requested: AgentLifecycleState): AgentCommandResult {
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

		const updated = this.updateAgent(current, { lifecycle: requested });
		return { ok: true, agent: copyAgent(updated) };
	}

	selectAgentView(agentId: string): AgentSnapshot | undefined {
		const agent = this.agents.get(agentId);
		if (!agent) {
			return undefined;
		}

		this.selectedAgentId = agent.id;

		return copyAgent(agent);
	}

	getSelectedAgentId(): string | undefined {
		return this.selectedAgentId;
	}

	getAgent(agentId: string): AgentSnapshot | undefined {
		const agent = this.agents.get(agentId);
		return agent ? copyAgent(agent) : undefined;
	}

	listAgents(): AgentSnapshot[] {
		return Array.from(this.agents.values(), copyAgent);
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
			targetCheckpoint: input.targetCheckpoint,
		};
		this.mailboxMessages.set(message.id, message);

		const updated = this.updateAgent(current, { lifecycle: "steering_pending" });

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

		return { ok: true, agent: copyAgent(updated), message: copyMessage(updatedMessage) };
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

	private updateAgent(current: AgentNode, updates: Pick<AgentNode, "lifecycle">): AgentNode {
		const updated = {
			...current,
			...updates,
			revision: current.revision + 1,
			updatedAt: this.now(),
		};
		this.agents.set(updated.id, updated);

		return updated;
	}

	private createAgentId(): string {
		const id = `agent_${this.nextAgentNumber}`;
		this.nextAgentNumber += 1;

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

function canTransition(from: AgentLifecycleState, to: AgentLifecycleState): boolean {
	if (from === to && !TERMINAL_STATES.has(from)) {
		return true;
	}

	return ALLOWED_TRANSITIONS.get(from)?.has(to) ?? false;
}

function copyAgent(agent: AgentNode): AgentSnapshot {
	return {
		...agent,
		account: copyOptional(agent.account),
		error: copyOptional(agent.error),
		lastActivity: copyOptional(agent.lastActivity),
		model: copyOptional(agent.model),
		permission: { ...agent.permission },
		result: copyResult(agent.result),
		slot: copyOptional(agent.slot),
		transcript: copyOptional(agent.transcript),
		worktree: copyOptional(agent.worktree),
	};
}

function copyMessage(message: AgentMailboxMessage): AgentMailboxMessage {
	return {
		...message,
		artifactIds: message.artifactIds ? [...message.artifactIds] : undefined,
	};
}

function copyOptional<T extends object>(value: T | undefined): T | undefined {
	return value ? { ...value } : undefined;
}

function copyResult(result: AgentResult | undefined): AgentResult | undefined {
	return result
		? {
				...result,
				artifactIds: result.artifactIds ? [...result.artifactIds] : undefined,
			}
		: undefined;
}
