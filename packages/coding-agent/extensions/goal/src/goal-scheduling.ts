import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PENDING_DECISION_RETRY_DELAY_MS = 1_000;
const WAIT_REVIEW_DELAY_MS = 5 * 60 * 1_000;

type TerminalTurn = AgentEndEvent["messages"];

interface GoalSchedulingOptions<TGoal, TDecision> {
	pi: ExtensionAPI;
	reviewGoal: (ctx: ExtensionContext, goal: TGoal, terminalTurn: TerminalTurn) => Promise<TDecision>;
	applyDecision: (
		decision: TDecision,
		goal: TGoal,
		ctx: ExtensionContext,
		terminalTurn: TerminalTurn,
	) => Promise<void>;
	isSameRunningGoal: (ctx: ExtensionContext, goal: TGoal) => boolean;
}

export interface GoalScheduler<TGoal, TDecision> {
	clearAll(): void;
	clearSession(sessionId: string): void;
	deferDecision(decision: TDecision, goal: TGoal, ctx: ExtensionContext, terminalTurn: TerminalTurn): void;
	waitForAgentsOrScheduleReview(ctx: ExtensionContext, goal: TGoal, terminalTurn: TerminalTurn): Promise<void>;
}

function activeAgentCount(details: unknown): number {
	if (typeof details !== "object" || details === null || !("activeCount" in details)) return 0;
	return typeof details.activeCount === "number" ? details.activeCount : 0;
}

class GoalSchedulerImpl<TGoal, TDecision> implements GoalScheduler<TGoal, TDecision> {
	private readonly options: GoalSchedulingOptions<TGoal, TDecision>;
	private readonly pendingDecisionTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly waitReviewTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(options: GoalSchedulingOptions<TGoal, TDecision>) {
		this.options = options;
	}

	clearSession(sessionId: string): void {
		this.clearTimer(this.pendingDecisionTimers, sessionId);
		this.clearTimer(this.waitReviewTimers, sessionId);
	}

	clearAll(): void {
		this.clearTimers(this.pendingDecisionTimers);
		this.clearTimers(this.waitReviewTimers);
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
		const listResult = await this.options.pi.callTool("list_agents", { parentId: "main" });
		if (activeAgentCount(listResult.details) === 0) {
			this.scheduleWaitReview(ctx, goal, terminalTurn);
			return;
		}
		await this.options.pi.callTool("wait_agents", {});
		await this.reviewAndApply(ctx, goal, terminalTurn);
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

	private async reviewAndApply(ctx: ExtensionContext, goal: TGoal, terminalTurn: TerminalTurn): Promise<void> {
		if (!this.options.isSameRunningGoal(ctx, goal) || ctx.hasPendingMessages()) return;
		const decision = await this.options.reviewGoal(ctx, goal, terminalTurn);
		if (ctx.hasPendingMessages()) {
			this.deferDecision(decision, goal, ctx, terminalTurn);
			return;
		}
		await this.options.applyDecision(decision, goal, ctx, terminalTurn);
	}

	private scheduleWaitReview(ctx: ExtensionContext, goal: TGoal, terminalTurn: TerminalTurn): void {
		const sessionId = ctx.sessionManager.getSessionId();
		this.clearTimer(this.waitReviewTimers, sessionId);
		const timer = setTimeout(() => {
			this.waitReviewTimers.delete(sessionId);
			if (!ctx.isIdle()) {
				this.scheduleWaitReview(ctx, goal, terminalTurn);
				return;
			}
			void this.reviewAndApply(ctx, goal, terminalTurn);
		}, WAIT_REVIEW_DELAY_MS);
		this.waitReviewTimers.set(sessionId, timer);
	}

	private applyDeferredDecision(
		decision: TDecision,
		goal: TGoal,
		ctx: ExtensionContext,
		terminalTurn: TerminalTurn,
	): void {
		if (!this.options.isSameRunningGoal(ctx, goal) || !ctx.isIdle()) return;
		if (ctx.hasPendingMessages()) {
			this.deferDecision(decision, goal, ctx, terminalTurn);
			return;
		}
		void this.options.applyDecision(decision, goal, ctx, terminalTurn);
	}
}

export function createGoalScheduler<TGoal, TDecision>(
	options: GoalSchedulingOptions<TGoal, TDecision>,
): GoalScheduler<TGoal, TDecision> {
	return new GoalSchedulerImpl(options);
}
