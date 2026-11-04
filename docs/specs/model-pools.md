# Model pools

Module boundary: core model registry and streaming (`packages/coding-agent/src/core/model-registry.ts`
and `packages/coding-agent/src/core/model-pool.ts`).

A `pool/<name>` model routes each request through an ordered list of real provider/model members.
It selects another member only after terminal quota or balance exhaustion before output starts.
The selected model remains the pool; assistant messages retain the actual member identity.

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

### Request routing

- [x] Try members in configured order, skipping exhausted members, members without configured auth,
  and members whose request auth cannot resolve. Resolve each attempted member's own API key,
  headers, and environment; never use pool credentials for member requests.
- [x] Buffer `start` events until the first non-`start` event. Rotate only if that event is a terminal
  quota-exhaustion error, including `insufficient_quota` and DeepSeek's `Insufficient Balance`.
- [x] Forward all events from the chosen member unchanged. Non-quota errors and errors after text,
  thinking, or tool-call events do not rotate members.
- [x] Return the last attempted member's quota error if all attempts exhaust. If no member is
  eligible, return a clear error naming the pool.
- [x] Keep a 15-minute quota cooldown by real provider/model ID in registry-owned process memory.
  Skip the exhausted member on later requests, including after registry refresh, and retry it at
  expiry. Re-register the pool API after refresh resets API registrations.
- [x] Honor request cancellation before requests, during auth resolution, and while waiting for
  member output, without starting another member.
- [x] Match an assistant message to the selected model by exact provider/model identity, or by
  resolved pool membership when the selected model is a pool.

## How it works

- [Model pool configuration and request behavior](../../packages/coding-agent/docs/models.md#model-pools)
- [Existing terminal quota classification](codex-quota-fallback.md)

## Implementation inventory

- `packages/coding-agent/src/core/model-registry.ts` — loads pool configuration, rebuilds pool models,
  checks auth availability, and matches member messages.
- `packages/coding-agent/src/core/model-pool.ts` — derives capabilities, registers the pool API,
  resolves member auth, streams events, and keeps quota cooldowns.
- `packages/coding-agent/src/core/codex-quota-fallback.ts` — classifies terminal quota errors,
  including `Insufficient Balance`.
- `packages/coding-agent/docs/models.md` — documents the `pools` key and its limits.

## Tests asserting this spec

- `packages/coding-agent/test/model-pool.test.ts` — concrete registry fixtures and registered test
  streams cover parsing, capabilities, auth isolation, event preservation, quota-only rotation,
  cooldown expiry, refresh, cancellation, unavailable members, and message membership.
- `packages/coding-agent/test/model-registry.test.ts` — existing registry behavior remains covered.

## Out of scope

- Session integration, including use of the message-match helper in `agent-session.ts`, belongs to
  the integration slice.
- Provider-stated model equivalence is configuration, not per-request proof. For example, an
  operator can group DeepSeek `deepseek-flash` and OpenCode Go `deepseek-v4.1-flash` when the
  providers state that both serve V4.1 Flash 1017. These are movable aliases; the pool does not
  verify which weights or version served any request.
- Nested pools, round robin, transient-error retries, balance queries, persistent cooldowns, and
  automatic credit purchases are not part of this ordered quota-exhaustion provider.
