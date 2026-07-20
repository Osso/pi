import type {
	AgentEndEvent,
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const PENDING_DECISION_RETRY_DELAY_MS = 1_000;
const WAIT_REVIEW_DELAY_MS = 5 * 60 * 1_000;

type TerminalTurn = AgentEndEvent["messages"];

interface GoalSchedulingOptions<TGoal, TDecision> {
	pi: ExtensionAPI;
	reviewGoal: (ctx: ExtensionContext, goal: TGoal, terminalTurn: TerminalTurn, wakeEvidence?: unknown) => Promise<TDecision>;
	applyDecision: (
		decision: TDecision,
		goal: TGoal,
		ctx: ExtensionContext,
		terminalTurn: TerminalTurn,
	) => Promise<void>;
	isSameRunningGoal: (ctx: ExtensionContext, goal: TGoal) => boolean;
	reportError: (error: unknown) => void;
}

export interface GoalScheduler<TGoal, TDecision> {
	captureEpoch(ctx: ExtensionContext): number;
	clearAll(): void;
	clearSession(sessionId: string): void;
	deferDecision(decision: TDecision, goal: TGoal, ctx: ExtensionContext, terminalTurn: TerminalTurn): void;
	deferReview(goal: TGoal, ctx: ExtensionContext, terminalTurn: TerminalTurn): void;
	isEpochCurrent(ctx: ExtensionContext, epoch: number): boolean;
	waitForAgentsOrScheduleReview(ctx: ExtensionContext, goal: TGoal, terminalTurn: TerminalTurn): Promise<void>;
}

function toolError(result: AgentToolResult<unknown>, toolName: string): Error | null {
	if (!result.isError) return null;
	const message = result.content
		.filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();
	return new Error(message || `${toolName} failed`);
}

function activeAgentCount(details: unknown): number {
	if (typeof details !== "object" || details === null || !("activeCount" in details)) return 0;
	return typeof details.activeCount === "number" ? details.activeCount : 0;
}

class GoalSchedulerImpl<TGoal, TDecision> implements GoalScheduler<TGoal, TDecision> {
	private readonly options: GoalSchedulingOptions<TGoal, TDecision>;
	private readonly pendingDecisionTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly cancellationEpochs = new Map<string, number>();
	private readonly waitControllers = new Map<string, AbortController>();
	private readonly waitReviewTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(options: GoalSchedulingOptions<TGoal, TDecision>) {
		this.options = options;
	}

	captureEpoch(ctx: ExtensionContext): number {
		const sessionId = ctx.sessionManager.getSessionId();
		const epoch = this.cancellationEpochs.get(sessionId) ?? 0;
		this.cancellationEpochs.set(sessionId, epoch);
		return epoch;
	}

	isEpochCurrent(ctx: ExtensionContext, epoch: number): boolean {
		return (this.cancellationEpochs.get(ctx.sessionManager.getSessionId()) ?? 0) === epoch;
	}

	clearSession(sessionId: string): void {
		this.cancellationEpochs.set(sessionId, (this.cancellationEpochs.get(sessionId) ?? 0) + 1);
		this.clearTimer(this.pendingDecisionTimers, sessionId);
		this.clearTimer(this.waitReviewTimers, sessionId);
		this.clearWait(sessionId);
	}

	clearAll(): void {
		for (const [sessionId, epoch] of this.cancellationEpochs) this.cancellationEpochs.set(sessionId, epoch + 1);
		this.clearTimers(this.pendingDecisionTimers);
		this.clearTimers(this.waitReviewTimers);
		for (const controller of this.waitControllers.values()) controller.abort();
		this.waitControllers.clear();
	}

	deferReview(goal: TGoal, ctx: ExtensionContext, terminalTurn: TerminalTurn): void {
		this.scheduleReviewRetry(ctx, goal, terminalTurn);
	}

	deferDecision(decision: TDecision, goal: TGoal, ctx: ExtensionContext, terminalTurn: TerminalTurn): void {
		const sessionId = ctx.sessionManager.getSessionId();
		this.clearTimer(this.pendingDecisionTimers, sessionId);
		const timer = setTimeout(() => {
			this.pendingDecisionTimers.delete(sessionId);
			this.applyDeferredDecision(decision, goal, ctx, terminalTurn);
		}, PENDING_DECISION_RETRY_DELAY_MS);
		this.pendingDecisionTimers.set(sessionId, timer);
	}

	async waitForAgentsOrScheduleReview(ctx: ExtensionContext, goal: TGoal, terminalTurn: TerminalTurn): Promise<void> {
		const sessionId = ctx.sessionManager.getSessionId();
		const epoch = this.cancellationEpochs.get(sessionId) ?? 0;
		try {
			const listResult = await this.options.pi.callTool("list_agents", { parentId: "main" });
			if ((this.cancellationEpochs.get(sessionId) ?? 0) !== epoch) return;
			const listError = toolError(listResult, "list_agents");
			if (listError) throw listError;
			if (activeAgentCount(listResult.details) === 0) {
				this.scheduleWaitReview(ctx, goal, terminalTurn);
				return;
			}
			this.startAgentWait(ctx, goal, terminalTurn);
		} catch (error) {
			if ((this.cancellationEpochs.get(sessionId) ?? 0) !== epoch) return;
			this.options.reportError(error);
			this.scheduleWaitReview(ctx, goal, terminalTurn);
		}
	}

	private clearTimer(timers: Map<string, ReturnType<typeof setTimeout>>, sessionId: string): void {
		const timer = timers.get(sessionId);
		if (timer) clearTimeout(timer);
		timers.delete(sessionId);
	}

	private clearTimers(timers: Map<string, ReturnType<typeof setTimeout>>): void {
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
	}

	private clearWait(sessionId: string): void {
		this.waitControllers.get(sessionId)?.abort();
		this.waitControllers.delete(sessionId);
	}

	private async reviewAndApply(
		ctx: ExtensionContext,
		goal: TGoal,
		terminalTurn: TerminalTurn,
		wakeEvidence?: unknown,
	): Promise<void> {
		const reviewEpoch = this.captureEpoch(ctx);
		if (!this.options.isSameRunningGoal(ctx, goal)) return;
		if (ctx.hasPendingMessages()) {
			this.scheduleReviewRetry(ctx, goal, terminalTurn, wakeEvidence);
			return;
		}
		const decision = await this.options.reviewGoal(ctx, goal, terminalTurn, wakeEvidence);
		if (!this.isEpochCurrent(ctx, reviewEpoch) || !this.options.isSameRunningGoal(ctx, goal)) return;
		if (ctx.hasPendingMessages()) {
			this.deferDecision(decision, goal, ctx, terminalTurn);
			return;
		}
		await this.options.applyDecision(decision, goal, ctx, terminalTurn);
	}

	private scheduleReviewRetry(
		ctx: ExtensionContext,
		goal: TGoal,
		terminalTurn: TerminalTurn,
		wakeEvidence?: unknown,
	): void {
		const sessionId = ctx.sessionManager.getSessionId();
		this.clearTimer(this.waitReviewTimers, sessionId);
		const timer = setTimeout(() => {
			this.waitReviewTimers.delete(sessionId);
			if (!ctx.isIdle()) {
				this.scheduleReviewRetry(ctx, goal, terminalTurn, wakeEvidence);
				return;
			}
			void this.reviewAndApply(ctx, goal, terminalTurn, wakeEvidence).catch((error: unknown) =>
				this.options.reportError(error),
			);
		}, PENDING_DECISION_RETRY_DELAY_MS);
		this.waitReviewTimers.set(sessionId, timer);
	}

	private scheduleWaitReview(ctx: ExtensionContext, goal: TGoal, terminalTurn: TerminalTurn): void {
		const sessionId = ctx.sessionManager.getSessionId();
		this.clearTimer(this.waitReviewTimers, sessionId);
		const timer = setTimeout(() => {
			this.waitReviewTimers.delete(sessionId);
			if (!ctx.isIdle()) {
				this.scheduleReviewRetry(ctx, goal, terminalTurn);
				return;
			}
			void this.reviewAndApply(ctx, goal, terminalTurn).catch((error: unknown) => this.options.reportError(error));
		}, WAIT_REVIEW_DELAY_MS);
		this.waitReviewTimers.set(sessionId, timer);
	}

	private startAgentWait(ctx: ExtensionContext, goal: TGoal, terminalTurn: TerminalTurn): void {
		const sessionId = ctx.sessionManager.getSessionId();
		this.clearWait(sessionId);
		const controller = new AbortController();
		this.waitControllers.set(sessionId, controller);
		void this.waitForAgentWake(ctx, goal, terminalTurn, controller).catch((error: unknown) => {
			if (controller.signal.aborted) return;
			this.waitControllers.delete(sessionId);
			this.options.reportError(error);
			this.scheduleWaitReview(ctx, goal, terminalTurn);
		});
	}

	private async waitForAgentWake(
		ctx: ExtensionContext,
		goal: TGoal,
		terminalTurn: TerminalTurn,
		controller: AbortController,
	): Promise<void> {
		const waitResult = await this.options.pi.callTool("wait_agents", {}, controller.signal);
		if (controller.signal.aborted) return;
		const waitError = toolError(waitResult, "wait_agents");
		if (waitError) throw waitError;
		this.waitControllers.delete(ctx.sessionManager.getSessionId());
		await this.reviewAndApply(ctx, goal, terminalTurn, waitResult.details);
	}

	private applyDeferredDecision(
		decision: TDecision,
		goal: TGoal,
		ctx: ExtensionContext,
		terminalTurn: TerminalTurn,
	): void {
		if (!this.options.isSameRunningGoal(ctx, goal)) return;
		if (!ctx.isIdle()) {
			this.deferDecision(decision, goal, ctx, terminalTurn);
			return;
		}
		if (ctx.hasPendingMessages()) {
			this.deferDecision(decision, goal, ctx, terminalTurn);
			return;
		}
		void this.options
			.applyDecision(decision, goal, ctx, terminalTurn)
			.catch((error: unknown) => this.options.reportError(error));
	}
}

export function createGoalScheduler<TGoal, TDecision>(
	options: GoalSchedulingOptions<TGoal, TDecision>,
): GoalScheduler<TGoal, TDecision> {
	return new GoalSchedulerImpl(options);
}
