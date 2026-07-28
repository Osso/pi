import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface WaitCountdownRefresher {
	clearAll(): void;
	clearSession(sessionId: string): void;
	start(ctx: ExtensionContext, reviewAt: string): void;
}

class WaitCountdownRefresherImpl implements WaitCountdownRefresher {
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

	clearAll(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
	}

	clearSession(sessionId: string): void {
		const timer = this.timers.get(sessionId);
		if (timer) clearTimeout(timer);
		this.timers.delete(sessionId);
	}

	start(ctx: ExtensionContext, reviewAt: string): void {
		const sessionId = ctx.sessionManager.getSessionId();
		this.clearSession(sessionId);
		const deadlineMs = Date.parse(reviewAt);
		if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) return;
		this.scheduleNextRender(ctx, sessionId, deadlineMs);
	}

	private scheduleNextRender(ctx: ExtensionContext, sessionId: string, deadlineMs: number): void {
		const now = Date.now();
		const remainingMs = deadlineMs - now;
		if (remainingMs <= 0) return;
		const remainingSeconds = Math.ceil(remainingMs / 1_000);
		const nextChangeAt = deadlineMs - (remainingSeconds - 1) * 1_000;
		const timer = setTimeout(() => {
			this.timers.delete(sessionId);
			ctx.ui.requestRender();
			this.scheduleNextRender(ctx, sessionId, deadlineMs);
		}, Math.max(1, nextChangeAt - now));
		timer.unref?.();
		this.timers.set(sessionId, timer);
	}
}

export function createWaitCountdownRefresher(): WaitCountdownRefresher {
	return new WaitCountdownRefresherImpl();
}
