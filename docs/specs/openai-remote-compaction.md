# OpenAI Saved Compaction History

Pi has removed the optional `openai-remote-compact` extension and its OpenAI `/responses/compact` and Codex `/codex/responses/compact` endpoint integration. Existing provider-native saved history remains supported by the core compaction and OpenAI Responses serializers. Normal compaction produces plaintext summaries; generic compaction hooks remain available. See [saved-history handling](../wiki/systems/openai-remote-compaction.md) for implementation details.

## What it must do

- [x] Pi must not ship the removed endpoint-calling extension or its endpoint-only tests.
- [x] Selecting an existing OpenAI-native compaction in `/tree` must materialize a complete plaintext continuation summary through one call using the active model only when its provider/API exactly matches the saved checkpoint; no provider/model fallback is allowed. Materialization is non-persistent until save, and Escape or failure leaves the entry unchanged.
- [x] Saving an edited native summary must atomically replace the summary and remove the provider-native checkpoint plus OpenAI remote-compaction details while preserving entry identity, tree position, leaf, and token/duration metadata.
- [x] Later matching OpenAI provider payloads must use saved native replacement history instead of Pi's synthetic compaction-summary text. A newer plaintext compaction must prevent reuse of older native replacement history.
- [x] Removing the endpoint integration must preserve normal plaintext compaction and generic compaction hooks.

## How it works

- [OpenAI saved compaction history](../wiki/systems/openai-remote-compaction.md)
- [Compaction manual](../../packages/coding-agent/docs/compaction.md)

## Implementation inventory

- `packages/coding-agent/src/core/compaction/compaction.ts` — materializes provider-native checkpoints into plaintext without persisting.
- `packages/coding-agent/src/core/agent-session.ts` — validates the active provider/API, resolves auth, and owns cancellation.
- `packages/coding-agent/src/core/session-manager.ts` — reads saved compaction entries and atomically replaces native compactions with plaintext.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — coordinates `/tree` loading, editing, cancellation, and errors.
- `packages/agent-core/src/harness/messages.ts` — carries provider-native history through compaction-summary context conversion.
- `packages/ai/src/api/openai-responses-shared.ts` — substitutes matching native history while serializing later OpenAI Responses requests.

## Tests asserting this spec

- `packages/coding-agent/test/compaction-materialization.test.ts` — materialization request context, plaintext output, and abort behavior.
- `packages/coding-agent/test/agent-session-compaction-summary-edit.test.ts` — matching-model materialization, no pre-save mutation, and mismatch rejection.
- `packages/coding-agent/test/interactive-mode-compaction-edit.test.ts` — plaintext/native editor flows, cancellation, failure, and command routing.
- `packages/coding-agent/test/session-manager/update-compaction-summary.test.ts` — atomic native replacement, rollback, metadata/leaf preservation, and later plaintext serialization.

## Known gaps (current cycle)

None.

## Out of scope

- New OpenAI or Codex compact-endpoint requests, endpoint payload budgets, and endpoint-specific model selection.
- Removing or migrating existing provider-native saved history.
- Removing generic compaction hooks or normal plaintext compaction.
