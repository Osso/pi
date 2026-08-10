import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isStaleContextError } from "./stale-context.ts";

const ERROR_STATUS_SETTLEMENT_MS = 10;

interface ErrorStatusSchedulingOptions {
	onStatus: (ctx: ExtensionContext, message: string) => void;
}

export interface ErrorStatusScheduler {
	clearAll(): void;
	clearSession(sessionId: string): void;
	schedule(ctx: ExtensionContext, message: string): void;
}

class ErrorStatusSchedulerImpl implements ErrorStatusScheduler {
	private readonly options: ErrorStatusSchedulingOptions;
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(options: ErrorStatusSchedulingOptions) {
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

	private scheduleStatusCheck(
		ctx: ExtensionContext,
		message: string,
		sessionId: string,
		delayMs: number,
	): void {
		this.timers.set(sessionId, setTimeout(() => this.checkStatus(ctx, message, sessionId), delayMs));
	}

	private checkStatus(ctx: ExtensionContext, message: string, sessionId: string): void {
		try {
			if (ctx.hasPendingMessages()) {
				this.timers.delete(sessionId);
				return;
			}
			if (ctx.hasActiveRetry() || !ctx.isIdle()) {
				this.scheduleStatusCheck(ctx, message, sessionId, ERROR_STATUS_SETTLEMENT_MS);
				return;
			}
			this.timers.delete(sessionId);
			this.options.onStatus(ctx, message);
		} catch (error) {
			this.timers.delete(sessionId);
			if (!isStaleContextError(error)) throw error;
		}
	}

	schedule(ctx: ExtensionContext, message: string): void {
		const sessionId = ctx.sessionManager.getSessionId();
		this.clearSession(sessionId);
		const retryDelayMs = ctx.settingsManager?.getRetrySettings().baseDelayMs ?? 0;
		this.scheduleStatusCheck(ctx, message, sessionId, retryDelayMs + ERROR_STATUS_SETTLEMENT_MS);
	}
}

export function createErrorStatusScheduler(options: ErrorStatusSchedulingOptions): ErrorStatusScheduler {
	return new ErrorStatusSchedulerImpl(options);
}
