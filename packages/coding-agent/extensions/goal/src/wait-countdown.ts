import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

interface CountdownRenderBinding {
	requestRender: () => boolean;
	token: symbol;
}

interface ActiveCountdown {
	deadlineMs: number;
	reviewAt: string;
	timer: ReturnType<typeof setTimeout> | undefined;
}

export interface WaitCountdownRefresher {
	bind(sessionId: string, reviewAt: string, requestRender: () => boolean): () => void;
	clearAll(): void;
	clearSession(sessionId: string): void;
	start(ctx: ExtensionContext, reviewAt: string): void;
}

class WaitCountdownRefresherImpl implements WaitCountdownRefresher {
	private readonly activeCountdowns = new Map<string, ActiveCountdown>();
	private readonly renderBindings = new Map<string, Map<string, CountdownRenderBinding>>();

	bind(sessionId: string, reviewAt: string, requestRender: () => boolean): () => void {
		const bindings = this.renderBindings.get(sessionId) ?? new Map<string, CountdownRenderBinding>();
		const token = Symbol("goal-countdown-render");
		bindings.set(reviewAt, { requestRender, token });
		this.renderBindings.set(sessionId, bindings);
		return () => {
			const currentBindings = this.renderBindings.get(sessionId);
			if (currentBindings?.get(reviewAt)?.token !== token) return;
			currentBindings.delete(reviewAt);
			if (currentBindings.size === 0) this.renderBindings.delete(sessionId);
		};
	}

	clearAll(): void {
		for (const countdown of this.activeCountdowns.values()) {
			if (countdown.timer) clearTimeout(countdown.timer);
		}
		this.activeCountdowns.clear();
		this.renderBindings.clear();
	}

	clearSession(sessionId: string): void {
		this.cancelCountdown(sessionId);
		this.renderBindings.delete(sessionId);
	}

	start(ctx: ExtensionContext, reviewAt: string): void {
		const sessionId = ctx.sessionManager.getSessionId();
		this.cancelCountdown(sessionId);
		const deadlineMs = Date.parse(reviewAt);
		if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) return;
		const countdown: ActiveCountdown = { deadlineMs, reviewAt, timer: undefined };
		this.activeCountdowns.set(sessionId, countdown);
		this.scheduleNextRender(sessionId, countdown);
	}

	private cancelCountdown(sessionId: string): void {
		const countdown = this.activeCountdowns.get(sessionId);
		if (countdown?.timer) clearTimeout(countdown.timer);
		this.activeCountdowns.delete(sessionId);
	}

	private scheduleNextRender(sessionId: string, countdown: ActiveCountdown): void {
		const now = Date.now();
		const remainingMs = countdown.deadlineMs - now;
		if (remainingMs <= 0) return;
		const remainingSeconds = Math.ceil(remainingMs / 1_000);
		const nextChangeAt = countdown.deadlineMs - (remainingSeconds - 1) * 1_000;
		countdown.timer = setTimeout(() => {
			if (this.activeCountdowns.get(sessionId) !== countdown) return;
			countdown.timer = undefined;
			this.renderBindings.get(sessionId)?.get(countdown.reviewAt)?.requestRender();
			this.scheduleNextRender(sessionId, countdown);
		}, Math.max(1, nextChangeAt - now));
		countdown.timer.unref?.();
	}
}

export function createWaitCountdownRefresher(): WaitCountdownRefresher {
	return new WaitCountdownRefresherImpl();
}
