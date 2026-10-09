import type { Api, Model, ProviderDiagnosticEvent, StreamOptions } from "../types.ts";

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const REQUEST_ID_PATTERN = new RegExp(`^(?:${UUID_PATTERN}|req[_-][a-z0-9_-]{1,96})$`, "i");
const SERVER_MESSAGE_ID_PATTERN = new RegExp(`Please include the request ID (${UUID_PATTERN}) in your message\\.`, "i");
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

type FailureMetadata = Pick<ProviderDiagnosticEvent, "httpStatus" | "retryAfterMs" | "upstreamErrorCode" | "requestId">;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function extractMetadata(payload: unknown, suppliedId?: string | null): FailureMetadata {
	const event = record(payload);
	const response = record(event?.response);
	const error = record(event?.error) ?? record(response?.error);
	const headers = record(event?.headers);
	const headerId = headers
		? Object.entries(headers).find(([name]) => name.toLowerCase() === "x-request-id")?.[1]
		: undefined;
	const code = event?.code ?? error?.code ?? error?.type;
	const supplied = suppliedId ?? headerId ?? event?.request_id ?? error?.request_id ?? response?.request_id;
	const message = event?.message ?? error?.message;
	// Only this fixed server phrase may supply a UUID; never scan arbitrary prose.
	const id = supplied ?? (typeof message === "string" ? SERVER_MESSAGE_ID_PATTERN.exec(message)?.[1] : undefined);
	return {
		...(typeof code === "string" && ERROR_CODE_PATTERN.test(code) ? { upstreamErrorCode: code } : {}),
		...(typeof id === "string" && REQUEST_ID_PATTERN.test(id) ? { requestId: id } : {}),
	};
}

function warnObserverFailure(): void {
	try {
		console.warn("Provider diagnostic observer failed");
	} catch {
		// Even a failing warning sink must not affect the provider outcome.
	}
}

/** Private per-stream observer state. Never constructed on the unobserved path. */
export class CodexDiagnosticObserver {
	private readonly callback: NonNullable<StreamOptions["onDiagnostic"]>;
	private readonly model: Model<Api>;
	private readonly signal?: AbortSignal;
	private attempt?: {
		transport: ProviderDiagnosticEvent["transport"];
		attempt: number;
		maxAttempts?: number;
		startedAt: number;
	};
	private response?: { status: number; requestId: string | null; retryAfterMs?: number };
	private emitted = false;

	constructor(callback: NonNullable<StreamOptions["onDiagnostic"]>, model: Model<Api>, signal?: AbortSignal) {
		this.callback = callback;
		this.model = model;
		this.signal = signal;
	}

	begin(transport: ProviderDiagnosticEvent["transport"], attempt: number, maxAttempts?: number): void {
		this.attempt = { transport, attempt, maxAttempts, startedAt: Date.now() };
		this.response = undefined;
		this.emitted = false;
	}

	setTransport(transport: ProviderDiagnosticEvent["transport"]): void {
		if (this.attempt) this.attempt.transport = transport;
	}

	receiveResponse(response: Response, retryAfterMs?: number): void {
		this.response = { status: response.status, requestId: response.headers.get("x-request-id"), retryAfterMs };
	}

	failHttp(raw: string): void {
		let payload: unknown;
		try {
			payload = JSON.parse(raw);
		} catch {
			// Non-JSON HTTP errors have no structured code or request ID in the body.
		}
		this.emit("api", payload);
	}

	fail(error: unknown): void {
		const name = error instanceof Error ? error.name : undefined;
		const aborted =
			this.signal?.aborted ||
			(error instanceof Error && (name === "AbortError" || error.message === "Request was aborted"));
		const kind = aborted
			? "aborted"
			: name === "CodexApiError"
				? "api"
				: name === "CodexProtocolError"
					? "protocol"
					: "transport";
		const payload = name === "CodexApiError" ? record(error)?.payload : undefined;
		this.emit(kind, payload);
	}

	private emit(failureKind: ProviderDiagnosticEvent["failureKind"], payload?: unknown): void {
		if (!this.attempt || this.emitted) return;
		this.emitted = true;
		try {
			const { startedAt, maxAttempts, ...attempt } = this.attempt;
			const timestamp = Date.now();
			const response = this.response;
			const event: ProviderDiagnosticEvent = {
				phase: "error",
				timestamp,
				elapsedMs: Math.max(0, timestamp - startedAt),
				...attempt,
				failureKind,
				...(maxAttempts !== undefined ? { maxAttempts } : {}),
				...(response ? { httpStatus: response.status } : {}),
				...(response?.retryAfterMs !== undefined && Number.isFinite(response.retryAfterMs)
					? { retryAfterMs: response.retryAfterMs }
					: {}),
				...extractMetadata(payload, response?.requestId),
			};
			// Do not await observers or let rejected async observers escape as unhandled rejections.
			void Promise.resolve(this.callback(event, this.model)).catch(warnObserverFailure);
		} catch {
			warnObserverFailure();
		}
	}
}
