import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const ERROR_STATUS_POLL_MS = 10;

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
		if (ctx.hasPendingMessages()) return;
		const checkIdle = (): void => {
			try {
				if (!ctx.isIdle()) {
					this.timers.set(sessionId, setTimeout(checkIdle, ERROR_STATUS_POLL_MS));
					return;
				}
				this.timers.delete(sessionId);
				this.options.onStatus(message);
			} catch {
				this.timers.delete(sessionId);
			}
		};
		this.timers.set(sessionId, setTimeout(checkIdle, ERROR_STATUS_POLL_MS));
	}
}

export function createErrorStatusScheduler(options: ErrorStatusSchedulingOptions): ErrorStatusScheduler {
	return new ErrorStatusSchedulerImpl(options);
}
