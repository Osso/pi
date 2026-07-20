import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isStaleContextError } from "./stale-context.ts";

const ERROR_STATUS_SETTLEMENT_MS = 10;

interface ErrorStatusSchedulingOptions {
	onStatus: (message: string) => void;
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

	schedule(ctx: ExtensionContext, message: string): void {
		const sessionId = ctx.sessionManager.getSessionId();
		this.clearSession(sessionId);
		const retryDelayMs = ctx.settingsManager?.getRetrySettings().baseDelayMs ?? 0;
		const checkIdle = (): void => {
			try {
				if (ctx.hasPendingMessages()) {
					this.timers.delete(sessionId);
					return;
				}
				if (!ctx.isIdle()) {
					this.timers.set(sessionId, setTimeout(checkIdle, ERROR_STATUS_SETTLEMENT_MS));
					return;
				}
				this.timers.delete(sessionId);
				this.options.onStatus(message);
			} catch (error) {
				this.timers.delete(sessionId);
				if (!isStaleContextError(error)) throw error;
			}
		};
		this.timers.set(sessionId, setTimeout(checkIdle, retryDelayMs + ERROR_STATUS_SETTLEMENT_MS));
	}
}

export function createErrorStatusScheduler(options: ErrorStatusSchedulingOptions): ErrorStatusScheduler {
	return new ErrorStatusSchedulerImpl(options);
}
