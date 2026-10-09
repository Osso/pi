# Provider failure diagnostics

Sanitized Codex failure metadata supports diagnosis without capturing request content or changing recovery policy. Applies to `api: "openai-codex-responses"`, including provider aliases. See [providers](../../packages/coding-agent/docs/providers.md#failure-diagnostics), [SDK](../../packages/coding-agent/docs/sdk.md#provider-failure-diagnostics), and [extension response hooks](../../packages/coding-agent/docs/extensions.md#after_provider_response).

## What it must do

Checked requirements mean implemented in the inspected source, not independently verified. Deployment and execution evidence are recorded separately below. SDK wiring and `retryLayer` serialization were committed in `df248e4f2`.

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

## Deployment and operational proof

Verified operational state: 2026-10-09. Deployed source `43e048c00af26e0bf21999d51f5e404b8ec6e31d` from local `master` under the explicit user-approved deployment override; `./deploy.sh` exited 0. Receipt `/tmp/pi-diagnostics-deploy-result.json` records the source revision, launcher, build-tool provenance, installed hash, and `/tmp/pi-diagnostics-deploy.log`.

Installed binary SHA-256: `0815da1d9e0c68bc3a660806661568c7c4b41b4f327eb8d5629e4d51e2a06b94`. `/tmp/pi-diagnostics-runtime-before.json` and `/tmp/pi-diagnostics-runtime-after.json` record both eligible main runtimes (`01a11b35`, `40fcbe4f`) restarting by same-PID exec and matching this artifact afterward; reported health checks were OK. Main completed the bounded identity/health inventory; independent verifier 171 separately passed the artifact/source audit.

Targeted source proof: producer 52 tests passed, recorded in `/tmp/codex-diag-async-observer.{log,json}`; typed SDK automatic-sink scope 10 tests passed, recorded in `/tmp/codex-diag-typed-autosink.{log,json}`. JSON receipts identify exact tested revision, scope, and file hashes; both report proof still current. Prior combined 20-test proof is historical: its SDK/stream-options subset remains applicable, while the sink portion is superseded by the inspected post-refactor 10-test run. These bounded tests do not establish the unknown upstream cause or independently prove all retry-policy behavior.

Build used cached, provenance-verified Bun 1.4.0 with explicit launcher environment because the tmux shell resets PATH; global PATH was not changed. Dependency/package and browser-CLI work is separate from this feature.

## Pending acceptance

- [x] Commit SDK wiring, retry-layer serialization, and SDK integration tests (`df248e4f2`).
- [x] Deploy the approved source and confirm both eligible main runtimes execute the installed artifact.
- [x] Independent verifier 171 passed artifact/source audit at `43e048c00`: inspected deployment/check output, matching built/installed hashes, producer 52/52 and sink 10/10 logs/scope hashes, and applicable SDK evidence. Actual private log modes were 0700/0600; its 16 observed records were valid JSON with only allowlisted keys. No real provider probe or unsupported upstream-cause claim.

## Out of scope

Retry fixes, transport fallback changes, provider/model policy changes, dependency changes, and CLI output redesign.

Upstream cause remains unknown. Generic provider failures and connection timeouts do not establish quota exhaustion, excessive prompt size, or an OpenAI root cause. Server request IDs support upstream investigation; they do not explain the failure.
