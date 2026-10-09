export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";

/** Metadata-only observation of an actual failed provider attempt. No raw error or content fields. */
export interface ProviderDiagnosticEvent {
	phase: "error";
	/** Unix epoch milliseconds. */
	timestamp: number;
	/** Time since this provider attempt started, in milliseconds. */
	elapsedMs: number;
	/** Actual transport, not the requested "auto" setting. */
	transport: Exclude<Transport, "auto">;
	/** Actual provider attempt, including internal retries (1-based). */
	attempt: number;
	maxAttempts?: number;
	failureKind: "api" | "transport" | "protocol" | "aborted";
	httpStatus?: number;
	retryAfterMs?: number;
	upstreamErrorCode?: string;
	requestId?: string;
}
