# Thinking status indicator

Module boundary: core subsystem. The interactive-mode default working indicator at `packages/coding-agent/src/modes/interactive/interactive-mode.ts` reports elapsed duration while Pi is thinking. Implementation detail belongs in `docs/wiki/systems/thinking-status.md`.

## What it must do

### Default thinking status

- [x] At response start, show the default working label with elapsed duration, beginning as `Thinking... 0s` and formatting longer durations such as `Thinking... 1m 05s` (`packages/coding-agent/test/interactive-mode-thinking-timer.test.ts`).
- [x] Stop updating the thinking-duration indicator when the response ends (`packages/coding-agent/test/interactive-mode-thinking-timer.test.ts`).

### Tool waits

- [x] While an active tool controls the working row, the thinking-duration timer must not replace its tool-wait message (`packages/coding-agent/test/interactive-mode-thinking-timer.test.ts`).

## How it works

- [Thinking status implementation](../wiki/systems/thinking-status.md).

## Implementation inventory

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — owns the default working label, thinking-duration timer, and tool-wait precedence.

## Tests asserting this spec

- `packages/coding-agent/test/interactive-mode-thinking-timer.test.ts` — elapsed formatting, response-end shutdown, and tool-wait precedence.

## Known gaps (current cycle)

- None.

## Out of scope

- Custom working messages and indicators registered by extensions; their API contract remains in `packages/coding-agent/docs/extensions.md`.
- Tool-wait wording and tool-wait elapsed-duration formatting.
