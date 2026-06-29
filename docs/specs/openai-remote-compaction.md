# OpenAI Remote Compaction

OpenAI remote compaction uses OpenAI's `/responses/compact` endpoint for first-party OpenAI Responses models and preserves the returned native replacement history for later OpenAI requests. How it works is tracked in [OpenAI remote compaction](../wiki/systems/openai-remote-compaction.md).

## What it must do

- [x] Only first-party `openai` provider models using `openai-responses` and first-party `openai-codex` / `openai-codex-gc` provider models using `openai-codex-responses` are eligible for remote compaction.
- [x] Remote compaction requests must serialize compacted Pi messages into OpenAI Responses input items and send them to the provider's compact endpoint.
- [x] Remote compaction results must keep OpenAI's native replacement history in compaction entry details.
- [x] Later OpenAI provider payloads must replace Pi's synthetic compaction-summary text with the saved native replacement history.

## How it works

- [OpenAI remote compaction](../wiki/systems/openai-remote-compaction.md)

## Implementation inventory

- `packages/coding-agent/extensions/openai-remote-compact/src/index.ts` — first-party extension that handles compaction and rewrites OpenAI payloads.
- `packages/coding-agent/src/main.ts` — registers the first-party extension.

## Tests asserting this spec

- `packages/coding-agent/test/openai-remote-compact-extension.test.ts`

## Known gaps (current cycle)

- [ ] Live `/responses/compact` behavior is manually probed, but not part of automated tests because it requires paid OpenAI credentials.

## Out of scope

- Azure OpenAI support is not enabled until its `/responses/compact` URL and response contract are verified.
- The experimental `context_compaction` Responses item is not used because the public API rejected it in live probing.
