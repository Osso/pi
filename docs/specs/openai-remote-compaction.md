# OpenAI Remote Compaction

OpenAI remote compaction uses OpenAI's `/responses/compact` endpoint for first-party OpenAI Responses models and preserves the returned native replacement history for later OpenAI requests. How it works is tracked in [OpenAI remote compaction](../wiki/systems/openai-remote-compaction.md).

## What it must do

- [x] Only first-party `openai` provider models using `openai-responses` and first-party `openai-codex` / `openai-codex-gc` provider models using `openai-codex-responses` are eligible for remote compaction.
- [x] Remote compaction requests must serialize compacted Pi messages into OpenAI Responses input items and send them to the provider's compact endpoint.
- [x] Remote compaction results must keep OpenAI's native replacement history in compaction entry details.
- [x] When a compact request exceeds the 400,000-character serialized-input limit, it must retain prior OpenAI-native replacement history intact and allocate the remaining budget to newer raw context.
- [x] When prior OpenAI-native replacement history alone exceeds the 400,000-character serialized-input limit, remote compaction must preserve encrypted compaction items that fit, truncate non-encrypted native context, and continue.
- [x] An encrypted compaction item that cannot itself fit within the serialized-input limit must be omitted rather than exceed the limit or cancel compaction.
- [x] Truncation must not group raw tool calls across the boundary with prior native history or retain a raw call without its matching output.
- [x] Later OpenAI provider payloads must replace Pi's synthetic compaction-summary text with the saved native replacement history.

## How it works

- [OpenAI remote compaction](../wiki/systems/openai-remote-compaction.md)

## Implementation inventory

- `packages/coding-agent/extensions/openai-remote-compact/src/index.ts` — first-party extension that performs remote compaction and stores native replacement history.
- `packages/agent-core/src/harness/messages.ts` — carries provider-native history through compaction-summary context conversion.
- `packages/ai/src/api/openai-responses-shared.ts` — substitutes matching native history while serializing later OpenAI Responses requests.
- `packages/coding-agent/src/main.ts` — registers the first-party extension.

## Tests asserting this spec

- `packages/coding-agent/test/openai-remote-compact-extension.test.ts`

## Known gaps (current cycle)

- [ ] Live `/responses/compact` behavior is manually probed, but not part of automated tests because it requires paid OpenAI credentials.

## Out of scope

- Azure OpenAI support is not enabled until its `/responses/compact` URL and response contract are verified.
- The experimental `context_compaction` Responses item is not used because the public API rejected it in live probing.
