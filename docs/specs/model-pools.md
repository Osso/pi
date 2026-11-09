# Model pools

Module boundary: core model registry and streaming (`packages/coding-agent/src/core/model-registry.ts`
and `packages/coding-agent/src/core/model-pool.ts`), wired into SDK sessions (`sdk.ts`) and session
compaction (`agent-session.ts`).

A `pool/<name>` model routes each request through an ordered list of real provider/model members.
It selects another member only after terminal quota or balance exhaustion before output starts.
The selected model remains the pool; assistant messages retain the actual member identity.
Pools replace the former session-level OpenAI/Codex quota fallback: selecting a provider model
directly never switches accounts; select a pool for that.

## What it must do

### Configuration and capabilities

- [x] Accept an optional top-level `pools` object in `models.json`, with each pool name mapped to an
  ordered array of `provider/modelId` references. Split references at the first `/` only.
- [x] Skip unresolved individual members. Skip pools with no resolved members and report each pool
  through `ModelRegistry.getError()` without removing valid pools or real models.
- [x] Expose pool models with provider and API `pool`, the configured name as ID, and display name
  `Pool <name>`. Use the minimum context window and output limit, the intersection of input types,
  and the first resolved member's cost metadata.
- [x] Advertise reasoning only when all members support it. Map each pi thinking level to itself
  if all members support it, or to `null` otherwise. Keep each member's own thinking map intact.
- [x] Consider pool auth configured when any resolved member has configured auth. Pool credentials
  must not grant member access.
- [x] Report pool request auth as available when any member has configured auth, so session gates
  that require a key before streaming (compaction, branch summaries, summary materialization) work
  for pools; report an error naming the pool when no member has auth. The pool placeholder key never
  reaches a provider.

### Request routing

- [x] Try members in configured order, skipping exhausted members, members without configured auth,
  and members whose request auth cannot resolve. Resolve each attempted member's own API key,
  headers, and environment; never use pool credentials for member requests.
- [x] In SDK sessions, send each member request through the same per-model path as a direct
  selection, so the member gets its own provider attribution and session headers (for example
  OpenCode `x-opencode-session`), diagnostics, retry and timeout settings.
- [x] Outside the SDK path, layer caller headers and environment over the member's resolved auth,
  matching SDK precedence; the caller's API key never replaces the member's.
- [x] Buffer `start` events until the first non-`start` event. Rotate to the next member if that event
  is a terminal quota-exhaustion error (including `insufficient_quota`, DeepSeek's `Insufficient
  Balance`, and OpenRouter's HTTP 402 `requires more credits` and `Insufficient credits`) or an account
  rate limit: `rate limit`, `too many requests`, `429`, or a per-minute token/request limit such as
  OpenAI's TPM `Request too large`. Another member's account absorbs the throttle, so a rate-limited
  member never fails the turn while a later member can serve it.
- [x] Forward all events from the chosen member unchanged. Errors after text, thinking, or tool-call
  events do not rotate members. Other errors before output (server errors, timeouts, connection
  failures) end the request and go to the normal session retry on the same pool.
- [x] End the pool request with `<provider>/<id>: provider stream ended without a final event.` when
  a member stream ends without `done` or `error`.
- [x] Resolve each attempted member's auth once per request and pass it to the member stream, so a
  command-backed key runs once.
- [x] Route each pool through the registry that loaded it, even after another registry loads.
- [x] Treat a member's context overflow like a direct model's overflow: compact and retry.
- [x] When no member can serve and at least one is only rate limited, return a retryable error
  `Pool "<name>": every member is rate limited or out of quota; the next frees in <N>s.` with
  `retryAfterMs` set to the earliest rate-limit expiry, so the session retry reaches that member.
  Otherwise return the last attempted member's quota error, or, if no member is eligible, a clear
  error naming the pool.
- [x] Keep cooldowns by real provider/model ID in registry-owned process memory. A rate limit within
  `maxRetryDelayMs` skips the member for its `retryAfterMs`, or 60 seconds when it states none. Quota
  exhaustion, and a rate limit asking to wait longer than that cap, skip it for 15 minutes. Skip a
  cooling member on later requests, including after registry refresh, and retry it at expiry.
  Re-register the pool API after refresh resets API registrations.
- [x] Honor request cancellation before requests, during auth resolution, and while waiting for
  member output, without starting another member.
- [x] Match an assistant message to the selected model by exact provider/model identity, or by
  resolved pool membership when the selected model is a pool. Background and idle compaction use
  this match, so a pool session compacts from a cache its member wrote.

## How it works

- [Model pool configuration and request behavior](../../packages/coding-agent/docs/models.md#model-pools)
- Terminal quota classification: `isQuotaExhaustionError` in
  `packages/coding-agent/src/core/codex-quota-fallback.ts` (also used by the Supervisor's Codex
  provider rotation, which is independent of pools).

## Implementation inventory

- `packages/coding-agent/src/core/model-registry.ts` — loads pool configuration, rebuilds pool models,
  checks auth availability, and matches member messages.
- `packages/coding-agent/src/core/model-pool.ts` — derives capabilities, registers the pool API,
  resolves member auth, streams events, and keeps quota cooldowns.
- `packages/coding-agent/src/core/codex-quota-fallback.ts` — classifies terminal quota errors,
  including `Insufficient Balance`, `requires more credits` and `Insufficient credits`.
- `packages/coding-agent/src/core/sdk.ts` — routes pool models through the SDK per-model request path.
- `packages/coding-agent/src/core/agent-session.ts` — compaction checks accept pool members.
- `packages/coding-agent/docs/models.md` — documents the `pools` key and its limits.

## Tests asserting this spec

- `packages/coding-agent/test/model-pool.test.ts` — concrete registry fixtures and registered test
  streams cover parsing, capabilities, auth isolation, event preservation, quota and rate-limit
  rotation, rate-limit and quota cooldown expiry, the all-rate-limited retryable error, refresh, cancellation, unavailable members, and message membership.
- `packages/coding-agent/test/model-registry.test.ts` — existing registry behavior remains covered.
- `packages/coding-agent/test/sdk-model-pool.test.ts` — SDK member path: per-member keys,
  OpenCode session header only on the OpenCode member, member identity on the result, and pool
  request auth from members.
- `packages/coding-agent/test/suite/idle-compaction.test.ts` — idle compaction of a pool session
  whose cache a member wrote.
- `packages/coding-agent/test/agent-session-retry.test.ts` — a quota error on a directly selected
  OpenAI/Codex provider ends the turn without selecting another provider.

## Out of scope

- Provider-stated model equivalence is configuration, not per-request proof. For example, an
  operator can group DeepSeek `deepseek-flash` and OpenCode Go `deepseek-v4.1-flash` when the
  providers state that both serve V4.1 Flash 1017. These are movable aliases; the pool does not
  verify which weights or version served any request.
- Nested pools, round robin, rotation on non-rate-limit transient errors, balance queries,
  persistent cooldowns, and automatic credit purchases are not part of this ordered provider.
