import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createProviderDiagnosticsLogger,
	serializeProviderDiagnostic,
	type ProviderDiagnosticInput,
} from "../src/core/provider-diagnostics.ts";

const model = { api: "openai-codex-responses", provider: "openai-codex-team", id: "gpt-6-astra" };
const context = { sessionId: "session-123", logicalRequestNumber: 7 };
const errorEvent = {
	phase: "error",
	timestamp: 1791540000123,
	elapsedMs: 250.5,
	transport: "websocket-cached",
	attempt: 2,
	maxAttempts: 4,
	failureKind: "api",
	httpStatus: 429,
	retryAfterMs: 1500,
	upstreamErrorCode: "rate_limit_exceeded",
	requestId: "req_abc-123",
} as const;

function serialized(event: unknown): unknown {
	const line = serializeProviderDiagnostic(event as ProviderDiagnosticInput, model, context);
	return line === undefined ? undefined : JSON.parse(line);
}

describe("provider diagnostics", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-provider-diagnostics-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("serializes the exact error contract with supplied timestamp and logical request number", () => {
		expect(serialized(errorEvent)).toEqual({
			phase: "error",
			timestamp: 1791540000123,
			elapsedMs: 250.5,
			transport: "websocket-cached",
			attempt: 2,
			maxAttempts: 4,
			failureKind: "api",
			httpStatus: 429,
			retryAfterMs: 1500,
			upstreamErrorCode: "rate_limit_exceeded",
			requestId: "req_abc-123",
			provider: "openai-codex-team",
			model: "gpt-6-astra",
			sessionId: "session-123",
			logicalRequestNumber: 7,
		});
	});

	it("serializes only retry numbers and fallback transport, never reason or error metadata", () => {
		expect(
			serialized({
				...errorEvent,
				phase: "retry",
				delayMs: 1000,
				fallbackTransport: "sse",
				reason: "Bearer private-secret",
			}),
		).toEqual({
			phase: "retry",
			timestamp: 1791540000123,
			attempt: 2,
			maxAttempts: 4,
			delayMs: 1000,
			fallbackTransport: "sse",
			provider: "openai-codex-team",
			model: "gpt-6-astra",
			sessionId: "session-123",
			logicalRequestNumber: 7,
		});
	});

	it("appends exact JSONL repeatedly with private directory and file modes", () => {
		const logger = createProviderDiagnosticsLogger({
			agentDir: dir,
			warn: () => {
				throw new Error("unexpected warning");
			},
		});
		logger.append(errorEvent, model, context);
		logger.append(
			{ phase: "retry", timestamp: 1791540000456, attempt: 2, maxAttempts: 4, delayMs: 100 },
			model,
			context,
		);
		const folder = join(dir, "logs", "provider-diagnostics");
		const file = join(folder, "codex.jsonl");
		expect(statSync(folder).mode & 0o777).toBe(0o700);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(readFileSync(file, "utf8")).toBe(
			`${serializeProviderDiagnostic(errorEvent, model, context)}\n${serializeProviderDiagnostic({ phase: "retry", timestamp: 1791540000456, attempt: 2, maxAttempts: 4, delayMs: 100 }, model, context)}\n`,
		);
		chmodSync(folder, 0o755);
		chmodSync(file, 0o644);
		logger.append(errorEvent, model, context);
		expect(statSync(folder).mode & 0o777).toBe(0o700);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(3);
	});

	it("never logs adversarial nested data or invokes unknown payload serialization", () => {
		const event = {
			...errorEvent,
			prompt: "PROMPT_SECRET",
			tools: [{ token: "TOOL_SECRET" }],
			body: { messages: ["BODY_SECRET"], headers: { authorization: "AUTH_SECRET" }, cookies: "COOKIE_SECRET" },
			stack: "STACK_SECRET",
			toJSON: () => {
				throw new Error("must not serialize event");
			},
		};
		const logger = createProviderDiagnosticsLogger({ agentDir: dir, warn: () => {} });
		const callbackModel = { ...model, headers: { token: "MODEL_SECRET" } };
		const requestContext = { ...context, prompt: "CONTEXT_SECRET" };
		logger.append(event, callbackModel, requestContext);
		const text = readFileSync(join(dir, "logs/provider-diagnostics/codex.jsonl"), "utf8");
		expect(JSON.parse(text)).toEqual(serialized(errorEvent));
		expect(text).not.toContain("SECRET");
	});

	it("omits missing and invalid metadata without inventing HTTP or quota causes", () => {
		expect(serialized({ phase: "error", timestamp: 0 })).toEqual({
			phase: "error",
			timestamp: 0,
			provider: model.provider,
			model: model.id,
			...context,
		});
		expect(
			serialized({
				phase: "error",
				timestamp: 0,
				elapsedMs: -1,
				transport: "auto",
				attempt: 0,
				maxAttempts: NaN,
				failureKind: "quota",
				httpStatus: 99,
				retryAfterMs: Infinity,
				requestId: { token: "SECRET" },
				upstreamErrorCode: ["SECRET"],
			}),
		).toEqual(serialized({ phase: "error", timestamp: 0 }));
		expect(
			serialized({
				phase: "retry",
				timestamp: 0,
				attempt: 1.5,
				maxAttempts: -1,
				delayMs: -1,
				fallbackTransport: "auto",
			}),
		).toEqual({ phase: "retry", timestamp: 0, provider: model.provider, model: model.id, ...context });
		expect(serialized({ phase: "error", timestamp: NaN })).toBeUndefined();
		expect(serialized({ phase: "unknown", timestamp: 0 })).toBeUndefined();
	});

	it("bounds code and request ID and rejects controls, payloads, and secret sentinels", () => {
		for (const bad of [
			"line\nbreak",
			"line\rbreak",
			"tab\tbreak",
			"null\0byte",
			"unicode\u2028break",
			"Bearer-secret",
			"sk-private",
			"access_token",
			"SECRET_SENTINEL",
			"password",
			"cookie",
			"authorization",
			"eyJhbGciOiJIUzI1NiJ9.payload",
			'{"token":"private"}',
			"",
			" padded ",
		]) {
			expect(serialized({ phase: "error", timestamp: 0, upstreamErrorCode: bad, requestId: bad })).toEqual(
				serialized({ phase: "error", timestamp: 0 }),
			);
		}
		expect(
			serialized({ phase: "error", timestamp: 0, upstreamErrorCode: "c".repeat(64), requestId: "r".repeat(128) }),
		).toEqual({
			phase: "error",
			timestamp: 0,
			provider: model.provider,
			model: model.id,
			...context,
			upstreamErrorCode: "c".repeat(64),
			requestId: "r".repeat(128),
		});
		expect(
			serialized({ phase: "error", timestamp: 0, upstreamErrorCode: "c".repeat(65), requestId: "r".repeat(129) }),
		).toEqual(serialized({ phase: "error", timestamp: 0 }));
	});

	it("supports actual transports and failure kinds without guessed metadata", () => {
		for (const transport of ["sse", "websocket", "websocket-cached"]) {
			for (const failureKind of ["api", "transport", "protocol", "aborted"]) {
				expect(serialized({ phase: "error", timestamp: 0, transport, failureKind })).toEqual({
					phase: "error",
					timestamp: 0,
					provider: model.provider,
					model: model.id,
					...context,
					transport,
					failureKind,
				});
			}
		}
	});

	it("unsupported model APIs produce no file or directory", () => {
		const unsupported = { ...model, api: "openai-responses" };
		const logger = createProviderDiagnosticsLogger({ agentDir: dir, warn: () => {} });
		expect(serializeProviderDiagnostic(errorEvent, unsupported, context)).toBeUndefined();
		logger.append(errorEvent, unsupported, context);
		expect(existsSync(join(dir, "logs"))).toBe(false);
	});

	it("permission-denied destination leaves retry execution untouched", () => {
		chmodSync(dir, 0o500);
		const warnings: string[] = [];
		const logger = createProviderDiagnosticsLogger({ agentDir: dir, warn: (warning) => warnings.push(warning) });
		let retries = 0;
		try {
			logger.append(errorEvent, model, context);
			retries++;
			logger.append({ phase: "retry", timestamp: 0, attempt: 1, delayMs: 100 }, model, context);
			expect(retries).toBe(1);
			expect(warnings).toEqual(["Provider diagnostics could not be written."]);
			expect(existsSync(join(dir, "logs"))).toBe(false);
		} finally {
			chmodSync(dir, 0o700);
		}
	});

	it("I/O failure preserves provider outcome and reports one fixed sanitized warning", () => {
		const blocked = join(dir, "blocked");
		writeFileSync(blocked, "private-error-message", { mode: 0o600 });
		const warnings: string[] = [];
		const logger = createProviderDiagnosticsLogger({
			agentDir: join(blocked, "nonexistent"),
			warn: (warning) => warnings.push(warning),
		});
		const outcome = () => {
			logger.append(errorEvent, model, context);
			return "provider-outcome";
		};
		expect(outcome()).toBe("provider-outcome");
		expect(outcome()).toBe("provider-outcome");
		expect(warnings).toEqual(["Provider diagnostics could not be written."]);
		expect(warnings[0]).not.toContain(blocked);
		const throwingWarning = createProviderDiagnosticsLogger({
			agentDir: blocked,
			warn: () => {
				throw new Error("private-warning-error");
			},
		});
		expect(() => throwingWarning.append(errorEvent, model, context)).not.toThrow();
	});
});
