# Assistant public narration

Module boundary: core assistant presentation in interactive and plain print modes.

Signed Anthropic narration is returned public prose carried in a thinking block. Coding-agent presentation classifies it through `packages/coding-agent/src/core/assistant-narration.ts` without changing message content. See [presentation and incident evidence](../wiki/systems/end-turn-tool.md#public-narration-presentation).

## What it must do

- [x] Display signed public narration as normal assistant Markdown in interactive mode even when thinking is hidden, preserving content order before following tools.
- [x] Reclassify streamed content when the completed thinking signature arrives, making narration visible before a following long-running tool finishes.
- [x] Include public narration in plain print output using the same classification as interactive rendering.
- [x] Preserve original thinking text, block type, and signature in persisted messages, JSON output, and same-model provider replay.
- [x] Replay signed narration to a different model or provider (including the Claude bridge) as a text block, because it is the reply the user saw; drop other thinking from other models as before.
- [x] On Anthropic Messages replay to the same model, follow each signed narration block of a completed turn (one before the latest user message) with a text copy, because a reply replayed only as thinking makes the model answer again; the current tool loop is unchanged.
- [x] Keep genuine thinking under normal thinking visibility; do not promote missing, malformed, or unclassified signatures to public prose.
- [x] Display returned narration directly without rejecting `end_turn` or making an extra model regeneration request.

## How it works

- [Public narration presentation](../wiki/systems/end-turn-tool.md#public-narration-presentation).

## Implementation inventory

- `packages/ai/src/utils/narration.ts` — signed-narration signature classifier.
- `packages/coding-agent/src/core/assistant-narration.ts` — public assistant text including narration.
- `packages/ai/src/api/anthropic-messages.ts` — same-model narration text copy for completed turns.
- `packages/ai/src/api/transform-messages.ts` and `packages/coding-agent/extensions/claude-bridge/src/convert.ts` — cross-model narration replay as text.
- `packages/coding-agent/src/modes/interactive/components/assistant-message.ts` — assistant Markdown presentation and signature-arrival updates.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — streamed transcript updates before tool execution.
- `packages/coding-agent/src/modes/print-mode.ts` — plain assistant output selection.
- `packages/coding-agent/src/core/tools/end-turn.ts` — completion without narration regeneration.

## Tests asserting this spec

- `packages/coding-agent/test/assistant-narration-renderer.test.ts` — captured narration, visibility, ordering, unchanged messages, and malformed/unclassified signatures.
- `packages/coding-agent/test/interactive-mode-narration-stream.test.ts` — signature-arrival redraw while the provider response is still streaming; genuine thinking remains hidden.
- `packages/coding-agent/test/print-mode.test.ts` — narration output without exposing real thinking or changing signed messages; existing JSON integration asserts unchanged wire bodies.
- `packages/coding-agent/test/suite/end-turn-summarized-reply.test.ts` — completion without a regeneration request.
- `packages/coding-agent/test/suite/regressions/interactive-pty-narration-output.test.ts` — real CLI visibility before tool release and after process reload, signed persistence and provider replay; `PI_TEST_NARRATION_EXECUTABLE` selects the installed runtime for smoke proof.
- `packages/coding-agent/test/suite/regressions/interactive-pty-fast-narration-output.test.ts` — main-view PTY replay of original signed blocks from `anthropic-fast-narration.json` through fast `end_turn`, ordinary-text controls, repeated rounds, and real mid-turn persisted runtime mailbox acceptance; [evidence and limits](../wiki/systems/end-turn-tool.md#test-evidence).
- `packages/ai/test/anthropic-narration-replay.test.ts` — same-model text copy for completed turns; current tool loop unchanged.
- `packages/ai/test/transform-messages-cross-model-thinking.test.ts` and `packages/coding-agent/test/claude-bridge-convert.test.ts` — cross-model narration replay as text; same-model replay unchanged.
- `packages/coding-agent/test/fixtures/anthropic-narration.json` — captured incident content.

## Known gaps (current cycle)

None.

## Out of scope

- Recovering an exact original full answer from a returned narration summary.
- Exposing genuine thinking as public prose, or changing signed blocks or the current tool loop on replay.
- New fallback or compatibility behavior.
