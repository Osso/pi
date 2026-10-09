import { chmodSync, closeSync, fchmodSync, mkdirSync, openSync, writeFileSync } from "fs";
import { join } from "path";

export type ProviderTransport = "sse" | "websocket" | "websocket-cached";

/** A local callback contract; unknown producer fields are never copied. */
export type ProviderDiagnosticInput = Readonly<{
	phase: "error" | "retry";
	timestamp: number;
	attempt?: number;
	maxAttempts?: number;
	elapsedMs?: number;
	transport?: ProviderTransport;
	failureKind?: "api" | "transport" | "protocol" | "aborted";
	httpStatus?: number;
	retryAfterMs?: number;
	upstreamErrorCode?: string;
	requestId?: string;
	delayMs?: number;
	retryLayer?: "provider" | "session";
	fallbackTransport?: ProviderTransport;
}>;

/** Pass the model from the callback's second argument, not the current session model. */
export type ProviderDiagnosticModel = Readonly<{ api: string; provider: string; id: string }>;
/** The SDK logical request counter is independent of the provider's attempt counter. */
export type ProviderDiagnosticContext = Readonly<{ sessionId: string; logicalRequestNumber: number }>;
export type ProviderDiagnosticsLoggerOptions = Readonly<{ agentDir: string; warn: (warning: string) => void }>;

function nonnegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function validatedIdentifier(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return undefined;
	// ASCII identifiers only: no whitespace, controls, JSON, header values, or credential sentinels.
	if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) return undefined;
	if (/secret|password|cookie|authorization|bearer|token|api[_-]?key|sk[-_]|^eyJ/i.test(value)) return undefined;
	return value;
}

function validatedTransport(value: unknown): ProviderTransport | undefined {
	return value === "sse" || value === "websocket" || value === "websocket-cached" ? value : undefined;
}

const failureKinds = new Set<ProviderDiagnosticInput["failureKind"]>(["api", "transport", "protocol", "aborted"]);

function serializeRetryFields(event: ProviderDiagnosticInput) {
	return {
		retryLayer: event.retryLayer === "provider" || event.retryLayer === "session" ? event.retryLayer : undefined,
		delayMs: nonnegativeNumber(event.delayMs),
		fallbackTransport: validatedTransport(event.fallbackTransport),
	};
}

function serializeErrorFields(event: ProviderDiagnosticInput) {
	const status = positiveInteger(event.httpStatus);
	return {
		elapsedMs: nonnegativeNumber(event.elapsedMs),
		transport: validatedTransport(event.transport),
		failureKind: failureKinds.has(event.failureKind) ? event.failureKind : undefined,
		httpStatus: status !== undefined && status >= 100 && status <= 599 ? status : undefined,
		retryAfterMs: nonnegativeNumber(event.retryAfterMs),
		upstreamErrorCode: validatedIdentifier(event.upstreamErrorCode, 64),
		requestId: validatedIdentifier(event.requestId, 128),
	};
}

/** Pure JSON serializer. All timestamps and request identity come from the caller. */
export function serializeProviderDiagnostic(
	event: ProviderDiagnosticInput,
	model: ProviderDiagnosticModel,
	context: ProviderDiagnosticContext,
): string | undefined {
	if (model.api !== "openai-codex-responses") return undefined;
	if (event.phase !== "error" && event.phase !== "retry") return undefined;
	if (!Number.isSafeInteger(event.timestamp) || event.timestamp < 0) return undefined;

	const record: Record<string, string | number | undefined> = {
		phase: event.phase,
		timestamp: event.timestamp,
		provider: validatedIdentifier(model.provider, 128),
		model: validatedIdentifier(model.id, 128),
		sessionId: validatedIdentifier(context.sessionId, 128),
		logicalRequestNumber: positiveInteger(context.logicalRequestNumber),
		attempt: positiveInteger(event.attempt),
		maxAttempts: positiveInteger(event.maxAttempts),
		...(event.phase === "retry" ? serializeRetryFields(event) : serializeErrorFields(event)),
	};
	return JSON.stringify(record);
}

/** Synchronous append effect; failures never escape into provider outcome or retry handling. */
export function createProviderDiagnosticsLogger(options: ProviderDiagnosticsLoggerOptions): {
	append: (event: ProviderDiagnosticInput, model: ProviderDiagnosticModel, context: ProviderDiagnosticContext) => void;
} {
	const directory = join(options.agentDir, "logs", "provider-diagnostics");
	const file = join(directory, "codex.jsonl");
	let warned = false;
	return {
		append(event, model, context) {
			try {
				const line = serializeProviderDiagnostic(event, model, context);
				if (line === undefined) return;
				mkdirSync(directory, { recursive: true, mode: 0o700 });
				chmodSync(directory, 0o700);
				const descriptor = openSync(file, "a", 0o600);
				try {
					fchmodSync(descriptor, 0o600);
					writeFileSync(descriptor, `${line}\n`, "utf8");
				} finally {
					closeSync(descriptor);
				}
			} catch {
				if (warned) return;
				warned = true;
				try {
					options.warn("Provider diagnostics could not be written.");
				} catch {
					// A failed warning sink must not change the provider outcome either.
				}
			}
		},
	};
}
