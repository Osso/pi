# Assistant public narration

Signed Anthropic narration is returned public prose carried in a thinking block. Coding-agent presentation classifies it through `packages/coding-agent/src/core/assistant-narration.ts` without changing message content. See [presentation and incident evidence](../wiki/systems/end-turn-tool.md#public-narration-presentation).

## What it must do

- [x] Display signed public narration as normal assistant Markdown in interactive mode even when thinking is hidden, preserving content order before following tools.
- [x] Reclassify streamed content when the completed thinking signature arrives, making narration visible before a following long-running tool finishes.
- [x] Include public narration in plain print output using the same classification as interactive rendering.
- [ ] Preserve original thinking text, block type, and signature in persisted messages, JSON output, and provider replay.
- [x] Keep genuine thinking under normal thinking visibility; do not promote missing, malformed, or unclassified signatures to public prose.
- [x] Display returned narration directly without rejecting `end_turn` or making an extra model regeneration request.

## How it works

- [Public narration presentation](../wiki/systems/end-turn-tool.md#public-narration-presentation).

## Implementation inventory

- `packages/coding-agent/src/core/assistant-narration.ts` — shared signed-narration classifier.
- `packages/coding-agent/src/modes/interactive/components/assistant-message.ts` — assistant Markdown presentation and signature-arrival updates.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — streamed transcript updates before tool execution.
- `packages/coding-agent/src/modes/print-mode.ts` — plain assistant output selection.
- `packages/coding-agent/src/core/tools/end-turn.ts` — completion without narration regeneration.

## Tests asserting this spec

- `packages/coding-agent/test/assistant-narration-renderer.test.ts` — captured narration, late signature arrival, visibility, ordering, unchanged messages, and malformed/unclassified signatures.
- `packages/coding-agent/test/print-mode.test.ts` — narration output without exposing real thinking or changing signed messages; existing JSON integration asserts unchanged wire bodies.
- `packages/coding-agent/test/suite/end-turn-summarized-reply.test.ts` — completion without a regeneration request.
- `packages/coding-agent/test/suite/regressions/interactive-pty-narration-output.test.ts` — real CLI visibility before tool release and after process reload, signed persistence and provider replay.
- `packages/coding-agent/test/fixtures/anthropic-narration.json` — captured incident content.

## Known gaps (current cycle)

- [ ] Verify signed blocks in the next provider request after tool completion.

## Out of scope

- Recovering an exact original full answer from a returned narration summary.
- Exposing genuine thinking as public prose or changing provider wire content.
- New fallback or compatibility behavior.
