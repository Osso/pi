# OpenAI Remote Compaction

OpenAI remote compaction uses OpenAI's `/responses/compact` endpoint for first-party OpenAI Responses models and preserves the returned native replacement history for later OpenAI requests. How it works is tracked in [OpenAI remote compaction](../wiki/systems/openai-remote-compaction.md).

## What it must do

- [x] Only first-party `openai` provider models using `openai-responses` and first-party `openai-codex` / `openai-codex-gc` provider models using `openai-codex-responses` are eligible for remote compaction.
- [x] Remote compaction requests must serialize compacted Pi messages into OpenAI Responses input items and send them to the provider's compact endpoint.
- [x] Remote compaction requests must preserve Pi's system instructions, append compaction-only guidance that prioritizes deduplicated continuation context, and include optional user-provided `/compact` instructions.
- [x] Codex remote compaction must use `gpt-5.6-terra` regardless of the active Codex generation model, while preserving native history across Codex model switches.
- [x] Remote compaction results must keep OpenAI's native replacement history in both the compaction entry's provider-native checkpoint and its OpenAI remote-compaction details, while the persisted summary remains a synthetic placeholder.
- [x] When the compact endpoint returns provider-generated `message` rows that are identical except for response-item `id`, remote compaction must keep only the latest row while preserving every non-message item unchanged.
- [x] When a compact request exceeds the 400,000-character serialized-input limit, it must retain prior OpenAI-native replacement history intact when that history and any pinned split-turn opening user fit together, then allocate the remaining budget to newer raw context.
- [x] For split-turn compaction, the opening user message of the active turn must appear exactly once within the existing 400,000-character budget before prior non-encrypted native history or newer coherent raw context; tool-call/output pairs remain intact. Ordinary multi-turn payload selection is unchanged.
- [x] When prior OpenAI-native replacement history alone exceeds the 400,000-character serialized-input limit, remote compaction must preserve encrypted compaction items that fit, truncate non-encrypted native context, and continue.
- [x] An encrypted compaction item that cannot itself fit within the serialized-input limit must be omitted rather than exceed the limit or cancel compaction.
- [x] Truncation must not group raw tool calls across the boundary with prior native history or retain a raw call without its matching output.
- [x] Selecting an OpenAI-native compaction in `/tree` must materialize a complete plaintext continuation summary through one call using the active model only when its provider/API exactly matches the saved checkpoint; no provider/model fallback is allowed. Materialization is non-persistent until save, and Escape or failure leaves the entry unchanged.
- [x] Saving an edited native summary must atomically replace the summary and remove the provider-native checkpoint plus OpenAI remote-compaction details while preserving entry identity, tree position, leaf, and token/duration metadata. A newer plaintext compaction must prevent reuse of older native replacement history.
- [x] Later OpenAI provider payloads must replace Pi's synthetic compaction-summary text with the saved native replacement history, unless a newer plaintext compaction entry forms an invalidation barrier.

## How it works

- [OpenAI remote compaction](../wiki/systems/openai-remote-compaction.md)

## Implementation inventory

- `packages/coding-agent/extensions/openai-remote-compact/src/index.ts` — performs remote compaction, stores native replacement history, and stops history lookup at newer plaintext compactions.
- `packages/coding-agent/src/core/compaction/compaction.ts` — materializes provider-native checkpoints into plaintext without persisting.
- `packages/coding-agent/src/core/agent-session.ts` — validates the active provider/API, resolves auth, and owns cancellation.
- `packages/coding-agent/src/core/session-manager.ts` — atomically replaces native compactions with plaintext and rolls back failed persistence.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — coordinates `/tree` loading, editing, cancellation, and errors.
- `packages/agent-core/src/harness/messages.ts` — carries provider-native history through compaction-summary context conversion.
- `packages/ai/src/api/openai-responses-shared.ts` — substitutes matching native history while serializing later OpenAI Responses requests.
- `packages/coding-agent/src/main.ts` — registers the first-party extension.

## Tests asserting this spec

- `packages/coding-agent/test/compaction-materialization.test.ts` — materialization request context, plaintext output, and abort behavior.
- `packages/coding-agent/test/agent-session-compaction-summary-edit.test.ts` — matching-model materialization, no pre-save mutation, and mismatch rejection.
- `packages/coding-agent/test/interactive-mode-compaction-edit.test.ts` — plaintext/native editor flows, cancellation, failure, and command routing.
- `packages/coding-agent/test/session-manager/update-compaction-summary.test.ts` — atomic native replacement, rollback, metadata/leaf preservation, and later plaintext serialization.
- `packages/coding-agent/test/openai-remote-compact-extension.test.ts` — payload limits, Terra selection, tool-pair preservation, and plaintext invalidation barrier.
- `packages/coding-agent/test/openai-remote-compact-split-turn.test.ts` — split-turn opening-user pinning within the payload limit.

## Known gaps (current cycle)

- [ ] Live `/responses/compact` behavior is manually probed, but not part of automated tests because it requires paid OpenAI credentials.

## Out of scope

- Azure OpenAI support is not enabled until its `/responses/compact` URL and response contract are verified.
- The experimental `context_compaction` Responses item is not used because the public API rejected it in live probing.
