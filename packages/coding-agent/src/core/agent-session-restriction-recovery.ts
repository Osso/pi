import { randomUUID } from "node:crypto";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import type { requestSupervisorDecision } from "../supervisor/client.ts";
import {
	type CodexRestrictionProposal,
	formatCodexRestrictionValidation,
	parseCodexRestrictionValidation,
	requestCodexRestrictionRescope,
} from "./provider-restriction-recovery.ts";
import { claimCodexRestrictionRecovery } from "./session-control-db.ts";
import type { SessionManager } from "./session-manager.ts";

const CODEX_RESTRICTION_CONTEXT_ENTRY = "codex_restriction_context";

interface CodexRestrictionContext {
	requestId: string;
	userRequest: string;
}

interface CodexRestrictionSnapshot {
	sessionId: string;
	requestId: string;
	cwd: string;
	goal: string | undefined;
	model: Model<Api> | undefined;
	messages: AgentMessage[];
}

interface CodexRestrictionValidation {
	proposal: CodexRestrictionProposal;
	failure: AssistantMessage;
	context: CodexRestrictionContext;
	snapshot: CodexRestrictionSnapshot;
	originalTools: AgentTool[];
	toolRevision: number;
}

interface RestrictionRecoveryDependencies {
	getSessionManager: () => SessionManager;
	getSessionId: () => string;
	getCwd: () => string;
	getModel: () => Model<Api> | undefined;
	getMessages: () => AgentMessage[];
	getGoal: () => string | undefined;
	isDisposed: () => boolean;
	isThinkingDispatchCancelled: () => boolean;
	isSupervisedMainSession: () => boolean;
	hasPendingMessages: () => boolean;
	hasQueuedMessages: () => boolean;
	getControlDbPath: () => string;
	getDecisionRequester: () => typeof requestSupervisorDecision;
	registerCancellation: (cancel: () => void) => () => void;
	sendCustomMessage: (message: { customType: string; content: string; display: boolean }) => Promise<void>;
	getActiveTools: () => AgentTool[];
	replaceActiveTools: (tools: AgentTool[]) => void;
	markThinkingRecoveryUsed: () => void;
}

export class CodexRestrictionRecoveryState {
	private context: CodexRestrictionContext | undefined;
	private contextSessionId: string | undefined;
	private contextLeafId: string | null | undefined;
	private abortController: AbortController | undefined;
	private validation: CodexRestrictionValidation | undefined;
	private attemptActive = false;
	private activeToolsRevision = 0;
	private readonly dependencies: RestrictionRecoveryDependencies;

	constructor(dependencies: RestrictionRecoveryDependencies) {
		this.dependencies = dependencies;
	}

	private readStoredContext(): CodexRestrictionContext | undefined {
		const entries = this.dependencies.getSessionManager().getBranch();
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry.type !== "custom" || entry.customType !== CODEX_RESTRICTION_CONTEXT_ENTRY) continue;
			const data = entry.data;
			if (typeof data !== "object" || data === null) return undefined;
			const userRequest = "userRequest" in data ? data.userRequest : undefined;
			const requestId = "requestId" in data ? data.requestId : undefined;
			return typeof userRequest === "string" && typeof requestId === "string" && requestId.length > 0
				? { userRequest, requestId }
				: undefined;
		}
		return undefined;
	}

	private loadContext(): CodexRestrictionContext | undefined {
		const sessionManager = this.dependencies.getSessionManager();
		const leafId = sessionManager.getLeafId();
		if (this.contextSessionId !== this.dependencies.getSessionId() || this.contextLeafId !== leafId) {
			this.context = this.readStoredContext();
			this.contextSessionId = this.dependencies.getSessionId();
			this.contextLeafId = leafId;
		}
		return this.context;
	}

	private saveContext(context: CodexRestrictionContext): void {
		this.context = context;
		this.contextSessionId = this.dependencies.getSessionId();
		const sessionManager = this.dependencies.getSessionManager();
		sessionManager.appendCustomEntry(CODEX_RESTRICTION_CONTEXT_ENTRY, context);
		this.contextLeafId = sessionManager.getLeafId();
	}

	private readMessages(): AgentMessage[] {
		return this.dependencies
			.getMessages()
			.filter((message) => message.role !== "custom" || message.customType !== "supervisor-status");
	}

	private canApplyAdvice(
		snapshot: CodexRestrictionSnapshot,
		cancelled: boolean,
		response?: AssistantMessage,
	): boolean {
		if (cancelled || this.dependencies.isDisposed() || this.dependencies.isThinkingDispatchCancelled()) return false;
		if (this.dependencies.getSessionId() !== snapshot.sessionId || this.dependencies.getCwd() !== snapshot.cwd)
			return false;
		if (this.dependencies.getModel() !== snapshot.model || this.loadContext()?.requestId !== snapshot.requestId)
			return false;
		if (this.dependencies.getGoal() !== snapshot.goal) return false;
		const messages = this.readMessages();
		const expectedCount = snapshot.messages.length + (response ? 1 : 0);
		if (messages.length !== expectedCount) return false;
		if (!snapshot.messages.every((message, index) => messages[index] === message)) return false;
		if (response && messages[messages.length - 1] !== response) return false;
		return !this.dependencies.hasPendingMessages() && !this.dependencies.hasQueuedMessages();
	}

	private async requestAdvice(message: AssistantMessage, userRequest: string) {
		const controller = new AbortController();
		this.abortController = controller;
		const unregister = this.dependencies.registerCancellation(() => controller.abort());
		try {
			const decision = await requestCodexRestrictionRescope({
				requester: this.dependencies.getDecisionRequester(),
				controlDbPath: this.dependencies.getControlDbPath(),
				senderSessionId: this.dependencies.getSessionId(),
				cwd: this.dependencies.getCwd(),
				originalUserRequest: userRequest,
				failure: message,
				signal: controller.signal,
				activeGoal: this.dependencies.getGoal(),
			});
			return { decision, cancelled: controller.signal.aborted };
		} finally {
			unregister();
			if (this.abortController === controller) this.abortController = undefined;
		}
	}

	private async displayBlocked(reason: string): Promise<false> {
		const content = `No validated narrower scope: ${reason}\nNo automatic task execution; original request remains pending.`;
		await this.dependencies.sendCustomMessage({
			customType: "supervisor_restriction_recovery",
			content,
			display: true,
		});
		return false;
	}

	private cancelValidation(): CodexRestrictionValidation | undefined {
		const pending = this.validation;
		this.validation = undefined;
		if (pending && this.activeToolsRevision === pending.toolRevision) {
			this.dependencies.replaceActiveTools(pending.originalTools);
		}
		return pending;
	}

	private async startValidation(
		failure: AssistantMessage,
		context: CodexRestrictionContext,
		proposal: CodexRestrictionProposal,
		snapshot: CodexRestrictionSnapshot,
	): Promise<true> {
		const originalTools = this.dependencies.getActiveTools();
		this.dependencies.replaceActiveTools([]);
		this.dependencies.markThinkingRecoveryUsed();
		this.validation = {
			proposal,
			context,
			failure,
			snapshot,
			originalTools,
			toolRevision: this.activeToolsRevision,
		};
		await this.dependencies.sendCustomMessage({
			customType: "supervisor_restriction_validation",
			content: formatCodexRestrictionValidation(context.userRequest, failure, proposal),
			display: true,
		});
		this.validation.snapshot = { ...snapshot, messages: this.readMessages() };
		return true;
	}

	private async finishValidation(message: AssistantMessage): Promise<boolean> {
		const pending = this.cancelValidation();
		if (!pending || this.activeToolsRevision !== pending.toolRevision) return false;
		if (!this.canApplyAdvice(pending.snapshot, false, message)) return false;
		const decision = parseCodexRestrictionValidation(message, pending.proposal, pending.context.userRequest);
		if (!decision.allowed) return this.displayBlocked(decision.reason);
		await this.dependencies.sendCustomMessage({
			customType: "supervisor_restriction_recovery",
			display: true,
			content: [
				`Main validated the narrower task: ${decision.task}`,
				`Reason: ${decision.reason}`,
				`Original user text cited: ${decision.basisQuote}`,
				`Original provider restriction: ${pending.failure.errorMessage}`,
				"Perform only this bounded task within original constraints. No additional permission or access is granted; do not replay completed effects or attempt the refused portions.",
			].join("\n"),
		});
		this.attemptActive = true;
		return true;
	}

	async prepareRecovery(message: AssistantMessage): Promise<boolean> {
		if (!this.dependencies.isSupervisedMainSession()) return false;
		if (this.dependencies.hasPendingMessages() || this.dependencies.hasQueuedMessages()) return false;
		const context = this.loadContext();
		if (!context) return this.displayBlocked("An explicit user request is required for review");
		if (!claimCodexRestrictionRecovery(this.dependencies.getControlDbPath(), context.requestId)) {
			return this.displayBlocked("Recovery was already used for this request; send a new request");
		}
		const snapshot: CodexRestrictionSnapshot = {
			sessionId: this.dependencies.getSessionId(),
			requestId: context.requestId,
			cwd: this.dependencies.getCwd(),
			goal: this.dependencies.getGoal(),
			model: this.dependencies.getModel(),
			messages: this.readMessages(),
		};
		const { decision, cancelled } = await this.requestAdvice(message, context.userRequest);
		if (!this.canApplyAdvice(snapshot, cancelled)) return false;
		if (decision.kind === "blocked") return this.displayBlocked(decision.reason);
		return this.startValidation(message, context, decision, snapshot);
	}

	abort(): void {
		this.abortController?.abort();
	}

	cancelPendingValidation(): void {
		this.abort();
		this.cancelValidation();
	}

	cancelValidationForTurn(): void {
		this.cancelValidation();
	}

	recordUserRequest(text: string, source: "extension" | string | undefined): void {
		if (source === "extension" || !this.dependencies.isSupervisedMainSession()) return;
		this.abort();
		this.cancelValidation();
		this.saveContext({ requestId: randomUUID(), userRequest: text });
	}

	markToolsReplaced(): void {
		this.activeToolsRevision++;
	}

	hasValidation(): boolean {
		return this.validation !== undefined;
	}

	isAttemptActive(): boolean {
		return this.attemptActive;
	}

	resetAttempt(): void {
		this.attemptActive = false;
	}

	async finishValidationFor(message: AssistantMessage): Promise<boolean> {
		return this.finishValidation(message);
	}

	willRetryAfterAgentEnd(message: AssistantMessage | undefined): boolean {
		if (!this.validation) return false;
		return (
			message !== undefined &&
			this.canApplyAdvice(this.validation.snapshot, false, message) &&
			parseCodexRestrictionValidation(message, this.validation.proposal, this.validation.context.userRequest).allowed
		);
	}
}
