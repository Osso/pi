import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const EMPTY_RESPONSE_RETRY_DELAY_MS = 1_000;

interface EmptyResponseSchedulingOptions<TGoal> {
	pi: ExtensionAPI;
	isSameRunningGoal: (ctx: ExtensionContext, goal: TGoal) => boolean;
}

export interface EmptyResponseScheduler<TGoal> {
	clearAll(): void;
	clearSession(sessionId: string): void;
	schedule(ctx: ExtensionContext, goal: TGoal): void;
}

class EmptyResponseSchedulerImpl<TGoal> implements EmptyResponseScheduler<TGoal> {
	private readonly options: EmptyResponseSchedulingOptions<TGoal>;
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(options: EmptyResponseSchedulingOptions<TGoal>) {
		this.options = options;
	}

	clearSession(sessionId: string): void {
		const timer = this.timers.get(sessionId);
		if (timer) clearTimeout(timer);
		this.timers.delete(sessionId);
	}

	clearAll(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
	}

	schedule(ctx: ExtensionContext, goal: TGoal): void {
		const sessionId = ctx.sessionManager.getSessionId();
		this.clearSession(sessionId);
		const timer = setTimeout(() => {
			this.timers.delete(sessionId);
			if (!this.options.isSameRunningGoal(ctx, goal) || ctx.hasPendingMessages() || !ctx.isIdle()) return;
			this.options.pi.sendUserMessage("Continue working toward the active goal.");
		}, EMPTY_RESPONSE_RETRY_DELAY_MS);
		this.timers.set(sessionId, timer);
	}
}

export function createEmptyResponseScheduler<TGoal>(
	options: EmptyResponseSchedulingOptions<TGoal>,
): EmptyResponseScheduler<TGoal> {
	return new EmptyResponseSchedulerImpl(options);
}
