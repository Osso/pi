# End-turn tool

[Contract](../../specs/end-turn-tool.md)

## Execution and loop

[`end-turn.ts`](../../../packages/coding-agent/src/core/tools/end-turn.ts) defines default-active, sequential `end_turn({reason})`. Blank/whitespace-only reasons throw. It also throws when the response that owns the call has no nonblank text but carries a thinking block whose signature decodes to block kind `narration`: Anthropic replaces prose emitted alongside a tool call with such a server summary, so the reply never reached the user, and the error makes the model resend it as a tool-free text response. Success returns text `Turn ended: …`, details containing the reason, and `terminate: true`. Registration is in [`tools/index.ts`](../../../packages/coding-agent/src/core/tools/index.ts).

[`agent-loop.ts`](../../../packages/agent-core/src/agent-loop.ts) stops automatic tool follow-up only when every finalized result in the batch requests termination. Mixing `end_turn` with a nonterminating result therefore does not end that batch's loop. Error, abort and provider `length` results remain terminal.

When `end_turn` is available, a text-only answer schedules another request. That request receives a runtime-only user instruction saying the previous response was delivered and requesting `end_turn`, without inferring new work. Pending real steering supersedes the instruction; it is not appended to persisted messages or `newMessages`.

[`agent-session.ts`](../../../packages/coding-agent/src/core/agent-session.ts) adds duplicate-text detection and recognizes a trailing all-`end_turn` batch with successful matching results as completed rather than interrupted. [`interactive-mode.ts`](../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) and [`rpc-mode.ts`](../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts) also consume extension-requested one-shot resume continuation.

[`print-mode.ts`](../../../packages/coding-agent/src/modes/print-mode.ts) searches backward through successful end-turn results/textless end-turn assistants to find printable text, stopping at other message boundaries. Errors preserve nonzero exits; JSON mode emits events.

## Limits

This ends the model loop, not Pi itself and not a running goal. Extensions can request further continuation. The completion-policy guidance is prompt text, not proof that task acceptance criteria were met.

## Test evidence

Inspected, not run: [`end-turn-tool.test.ts`](../../../packages/coding-agent/test/end-turn-tool.test.ts), [`agent-loop.test.ts`](../../../packages/agent-core/test/agent-loop.test.ts), [`agent-session-prompt.test.ts`](../../../packages/coding-agent/test/suite/agent-session-prompt.test.ts), [`print-mode.test.ts`](../../../packages/coding-agent/test/print-mode.test.ts), and [`print-mode-cli.test.ts`](../../../packages/coding-agent/test/suite/print-mode-cli.test.ts) cover validation, termination/continuation, duplicate guards and printing. Resume evidence is in [`7421-resume-session-tool.test.ts`](../../../packages/coding-agent/test/suite/regressions/7421-resume-session-tool.test.ts) and [`resume-continuation-request.test.ts`](../../../packages/coding-agent/test/suite/resume-continuation-request.test.ts).
