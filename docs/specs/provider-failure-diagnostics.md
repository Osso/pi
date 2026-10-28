# Provider failure diagnostics

Sanitized Codex failure metadata supports diagnosis without capturing request content or changing recovery policy. Applies to `api: "openai-codex-responses"`, including provider aliases. See [providers](../../packages/coding-agent/docs/providers.md#failure-diagnostics), [SDK](../../packages/coding-agent/docs/sdk.md#provider-failure-diagnostics), and [extension response hooks](../../packages/coding-agent/docs/extensions.md#after_provider_response).

## What it must do

Checked requirements describe the implemented contract. Execution evidence and its limits are recorded separately below.

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
| Producer | `packages/ai/src/types.ts`, `src/api/openai-codex-diagnostics.ts`, `src/api/openai-codex-responses.ts`, `src/api/simple-options.ts`; `packages/ai/test/openai-codex-stream.test.ts` covers failures, metadata filtering, observers, transports and attempts. | Implemented. |
| Sink | `packages/coding-agent/src/core/provider-diagnostics.ts`; allowlisting, permissions, isolated write failures and retry-layer serialization are covered by sink tests. | Implemented. |
| SDK | `packages/coding-agent/src/core/sdk.ts`; tests cover request correlation, callback preservation, retry-layer numbering, other-API exclusion and safe warning. | Implemented. |

## Deployment and operational proof

Pre-update source checked 2026-10-09: local `master` at `8e0187fae`, twelve commits ahead of `origin/master`; tracked modifications limited to this spec's status update. Diagnostics implementation and follow-up fixes are committed. Deployment receipt `/tmp/pi-diagnostics-deploy-result.json` records successful `./deploy.sh` at `43e048c00af26e0bf21999d51f5e404b8ec6e31d` (exit 0), installed binary SHA-256 `0815da1d9e0c68bc3a660806661568c7c4b41b4f327eb8d5629e4d51e2a06b94`, and build log `/tmp/pi-diagnostics-deploy.log`.

Runtime receipts `/tmp/pi-diagnostics-runtime-before.json` and `/tmp/pi-diagnostics-runtime-after.json` show both eligible main sessions (`01a11b35`, `40fcbe4f`) moved from the superseded executable hash to that installed hash. This is evidence of deployment/runtime identity, not a new deployment performed in this status check.

Existing targeted proof: producer test receipt `/tmp/codex-diag-async-observer.json` reports 52/52 at `bedf73e12`; the separate verifier report records combined SDK/sink/stream-options proof 20/20 at `c49fcf371` and post-refactor sink proof 10/10. The receipts carry scope hashes and are recorded as still current for those scopes. No tests were rerun for this read-only status check.

Earlier verifier report `/tmp/pi-diagnostics-verification-report.txt` predates final deployment acceptance. Its missing check/deployment proof is not the current historical gate: independent verifier 171 later inspected deployment/check output, matching built/installed hashes, producer 52/52, sink 10/10 and applicable SDK evidence at `43e048c00`. Actual private log modes were 0700/0600; 16 observed records were valid JSON with only allowlisted keys. No genuine provider probe or upstream-cause claim. Direct CLI stdout and session-retry-cancellation execution were not established by those bounded tests; do not turn that absence into new user requirements or discard later acceptance.

Fresh artifact observation on 2026-10-09: `/home/osso/.local/share/pi/pi` hashes `337a761af432e265368d81a05d58bf5b414d3aed9c8179d115ca0ebf50729495`, **not** the historical diagnostics-deployment hash. Exact metadata receipt: `/tmp/pi-diagnostics-current-artifact-check.json`. Committed paths after `43e048c00` are only `PLAN.md` and this spec; that does not establish the currently installed artifact's source. Historical deployment/runtime acceptance remains historical. One bounded live-artifact observation (`/tmp/pi-diagnostics-live-artifact-check.json`) hashes both eligible main PIDs 59748/52211 as `816307a52d4f42598f556032ca5415a0a86a517bf91825188711959a28aeb9a9`, distinct from both installed and historical hashes. At that observation, replacement provenance and diagnostics runtime applicability were unproven. These historical observations do not establish the current deployment.

## Offline combined proof status

Actual offline execution at partially associated canonical source `854f221661663b5b2d1473a2caa82fcb4f08113d`, with corrected private, uncommitted SSE test overlay SHA-256 `e9acf20b6b5e328384db32d0c911c97cbfb26291e0160ca6386c6242b68bbad0`: saved stdout reports one file, one passing test (85 ms; total 6.23 s); systemd exit 0, runtime 7.107 s. Independent saved-output and assertion audit accepts this bounded source proof; no runtime rerun. It covers direct SDK stream invocation, not `session.prompt`, a full agent turn, successful SSE parsing, or WebSocket behavior.

Two sequential mock HTTP 400/422 responses exercised the actual Codex producer → SDK normal `streamFn` → real private JSONL sink, asserting the exact 14-field allowlist, correlation `[1, 2]`, caller results and sensitive-data exclusion. Neither provider nor logger was fabricated. Execution used network-isolated bwrap, a cleared environment and private HOME/config, without real provider credentials or API calls. The test read and asserted the real file, then cleaned it; the private observer retained zero JSONL snapshots. This is not retained JSONL-record evidence.

Before/after fingerprints matched for selected canonical text/config/source/test/dist, the overlay and seven selected dependency texts. This is partial association, not whole-transitive-dependency, source-only, build, installed or live-artifact proof. This evidence does not establish installed or live runtime provenance, an actual provider failure, or credit units.

## Out of scope

Retry fixes, transport fallback changes, provider/model policy changes, dependency changes, and CLI output redesign.

Upstream cause remains unknown. Generic provider failures and connection timeouts do not establish quota exhaustion, excessive prompt size, or an OpenAI root cause. Server request IDs support upstream investigation; they do not explain the failure.
