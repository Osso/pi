# Provider failure diagnostics

Sanitized Codex failure metadata supports diagnosis without capturing request content or changing recovery policy. Applies to `api: "openai-codex-responses"`, including provider aliases. See [providers](../../packages/coding-agent/docs/providers.md#failure-diagnostics), [SDK](../../packages/coding-agent/docs/sdk.md#provider-failure-diagnostics), and [extension response hooks](../../packages/coding-agent/docs/extensions.md#after_provider_response).

## What it must do

Checked criteria mean implemented in the inspected source, not deployed or independently verified. SDK wiring and `retryLayer` serialization were committed in `df248e4f2` during this documentation task.

### Metadata and correlation

- [x] Record only error/retry diagnostics with `timestamp` in Unix epoch milliseconds; omit unavailable or invalid metadata rather than inventing values.
- [x] Correlate SDK stream invocations with `sessionId` and `logicalRequestNumber`, separately from provider-internal attempts. Use the callback model for provider metadata.
- [x] Record available server request IDs from HTTP and structured streamed failures; never substitute Pi/client/session IDs or requested `auto` transport for actual transport.

### Private logging

- [x] Append allowlisted JSONL to `<agentDir>/logs/provider-diagnostics/codex.jsonl`; enforce `0700` on the logger directory and `0600` on the file.
- [x] Exclude prompts, tool content, raw reasons/messages, error stacks, raw request/response bodies, header collections, cookies, tokens, and credentials.
- [x] Contain logger failures; SDK emits the fixed safe stderr warning `Provider diagnostics could not be written.` at most once per logger instance, without the caught error.
- [x] Leave provider/model selection, transport policy, retry classification, budgets, delays, request outcomes, and CLI stdout formats unchanged.

## JSONL schema

Fields outside this allowlist are not copied. Invalid identifiers or numeric values are omitted; unsupported APIs or invalid phase/timestamp produce no record.

| Fields | Meaning |
| --- | --- |
| `phase`, `timestamp` | `error` or `retry`; nonnegative integer Unix epoch milliseconds, not an ISO UTC string. |
| `provider`, `model` | Validated callback model identifiers. |
| `sessionId`, `logicalRequestNumber` | Validated session identifier and positive SDK stream-invocation counter. Counter increments after successful auth resolution; it is not a durable restart-wide counter. |
| `attempt`, `maxAttempts` | Positive 1-based attempt number and total attempt budget including the initial attempt, when available. Interpret within the relevant retry layer, not across layers. |
| Error: `elapsedMs`, `transport`, `failureKind` | Time since provider attempt start in milliseconds; actual `sse`, `websocket`, or `websocket-cached`; `api`, `transport`, `protocol`, or `aborted`. |
| Error: `httpStatus`, `retryAfterMs`, `upstreamErrorCode`, `requestId` | Available HTTP status, parsed Retry-After milliseconds, validated structured upstream code, and validated server request ID. |
| Retry: `retryLayer`, `delayMs`, `fallbackTransport` | `provider` or `session`; scheduled delay in milliseconds; actual fallback transport only if supplied by the retry callback. |

Provider error attempts count internal provider attempts within a stream invocation. Provider retry records copy the existing callback's next attempt and total budget and carry `retryLayer: "provider"`. Session retry records carry `retryLayer: "session"`: SDK converts the session retry ordinal and retry budget with `+1` to the next total attempt number and `maxAttempts`, respectively. A first session retry with one allowed retry therefore records `attempt: 2`, `maxAttempts: 2`.

A session retry record uses the preceding logical request's context. Its subsequent stream invocation receives a new `logicalRequestNumber`; provider-internal attempts do not increment that counter. Error records do not carry `retryLayer`.

## Availability and privacy limits

Missing fields mean unavailable, not zero or a known cause. WebSocket error diagnostics do not provide an HTTP status, Retry-After, or maximum-attempt budget. Transport failures and protocol errors may have no upstream code or request ID. Pre-request validation failures do not produce a failed-attempt diagnostic. SSE metadata depends on whether an HTTP response was received.

Request IDs come from supported structured fields or the producer's fixed server-message phrase, not arbitrary prose. Producer extraction and sink serialization both validate metadata. `onRetry` may expose a raw reason to callers, and extension response hooks may expose headers; neither is copied into this private log. This contract does not sanitize other logs, transcripts, or caller-owned callbacks.

## Implementation and proof inventory

| Scope | Source and coverage | Status |
| --- | --- | --- |
| Producer | `packages/ai/src/types.ts`, `src/api/openai-codex-diagnostics.ts`, `src/api/openai-codex-responses.ts`, `src/api/simple-options.ts`; `packages/ai/test/openai-codex-stream.test.ts` covers failures, metadata filtering, observers, transports and attempts. | Committed in `e44f12018`; control-character fixture added in `bdd4167e8`. Source/test inspection only in this docs task. |
| Sink | `packages/coding-agent/src/core/provider-diagnostics.ts`; `test/provider-diagnostics.test.ts` covers allowlisting, permissions and isolated write failures. | Base committed in `4f31df937`; `retryLayer` addition committed in `df248e4f2`. |
| SDK | `packages/coding-agent/src/core/sdk.ts`; `test/sdk-provider-diagnostics.test.ts` asserts request correlation, callback preservation, retry-layer numbering, other-API exclusion and one safe warning. | Initially uncommitted source/test inspected, then committed in `df248e4f2`; no execution proof claimed. |

## Pending acceptance

- [x] Commit SDK wiring, retry-layer serialization, and SDK integration tests (`df248e4f2`).
- [ ] Obtain independent proof of producer metadata, sink permissions/redaction/failure isolation, SDK correlation, and unchanged stdout/retry behavior.
- [ ] Deploy and verify the installed runtime. Deployment status is not established by this documentation change.

## Out of scope

Retry fixes, transport fallback changes, provider/model policy changes, dependency changes, and CLI output redesign.

Upstream cause remains unknown. Generic provider failures and connection timeouts do not establish quota exhaustion, excessive prompt size, or an OpenAI root cause. Server request IDs support upstream investigation; they do not explain the failure.
