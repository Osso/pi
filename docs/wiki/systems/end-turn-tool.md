# End-turn tool

[Contract](../../specs/end-turn-tool.md)

## Execution and loop

[`end-turn.ts`](../../../packages/coding-agent/src/core/tools/end-turn.ts) defines default-active, sequential `end_turn({reason})`. Blank/whitespace-only reasons throw. Signed public narration is a presentation concern under the [public-narration contract](../../specs/assistant-narration.md), not grounds for rejecting completion or requesting a regenerated answer. Success returns text `Turn ended: …`, details containing the reason, and `terminate: true`. Registration is in [`tools/index.ts`](../../../packages/coding-agent/src/core/tools/index.ts).

[`agent-loop.ts`](../../../packages/agent-core/src/agent-loop.ts) stops automatic tool follow-up only when every finalized result in the batch requests termination. Mixing `end_turn` with a nonterminating result therefore does not end that batch's loop. Error, abort and provider `length` results remain terminal.

When `end_turn` is available, a text-only answer schedules another request. That request receives a runtime-only user instruction saying the previous response was delivered and requesting `end_turn`, without inferring new work. Pending real steering supersedes the instruction; it is not appended to persisted messages or `newMessages`.

[`agent-session.ts`](../../../packages/coding-agent/src/core/agent-session.ts) adds duplicate-text detection and recognizes a trailing all-`end_turn` batch with successful matching results as completed rather than interrupted. [`interactive-mode.ts`](../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) and [`rpc-mode.ts`](../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts) also consume extension-requested one-shot resume continuation.

[`print-mode.ts`](../../../packages/coding-agent/src/modes/print-mode.ts) searches backward through successful end-turn results/textless end-turn assistants to find printable text, stopping at other message boundaries. Errors preserve nonzero exits; JSON mode emits events.

## Child report guard

The [child report contract](../../specs/end-turn-tool.md#child-report-requirement) is implemented by extension-owned [`child-report.ts`](../../../packages/coding-agent/extensions/agents-core/src/child-report.ts). Both spawned and attached factories in `runtime.ts` install its custom `end_turn` through `customTools`. It reconstructs report eligibility from the durable current branch after the latest user prompt, rather than adding persistent state. A nonblank ordinary assistant text block or server-signed public narration qualifies. A nonblank `contact_parent.body` qualifies only with a result linked to its current tool call, no `isError`, a nonblank `details.message.id`, and `details.message.status` equal to `pending`, `claimed`, or `accepted`. A failed transport status does not qualify even when `isError` is false. These statuses establish successful send evidence, not proof that the parent has read the message. Inherited parent text, prior-task reports, private thinking, whitespace, and failed contact attempts do not qualify.

Without a report, the tool returns an actionable error without termination, allowing another model response. Main-session textless completion stays unchanged. There is no automatic report, opt-out, compatibility path, fallback, model gate, policy evaluator, or extra persistent report state. [`child-response.ts`](../../../packages/coding-agent/extensions/agents-core/src/child-response.ts) includes accepted public narration in current-dispatch parent result extraction through the existing public-text helper. The guard checks report presence and successful send evidence; it does not assess the semantic quality or correctness of model findings.

## Public narration presentation

[`assistant-narration.ts`](../../../packages/coding-agent/src/core/assistant-narration.ts) classifies signatures whose base64 protobuf envelope field 2 → 1 → 8 equals `narration`. The interactive assistant renderer presents that block's returned text as ordinary Markdown, including when thinking is hidden, once the signature arrives. Print output must use the same classification. Original thinking content and signature remain unchanged for persistence, JSON output, and provider replay; genuine or unclassified thinking retains normal thinking visibility.

The [captured incident fixture](../../../packages/coding-agent/test/fixtures/anthropic-narration.json), assistant entry `91f9866c`, contained ordinary thinking followed by signed narration; the original message then called Bash. Hiding both thinking blocks hid the returned public prose. The installed Claude Code decoder (`Osn`/`ebe`) uses the same signature path; its thinking renderer routes `Zwt(l)` narration through public assistant rendering (`Ha`/`Hm`, labelled summary), versus ordinary thinking (`Cs`). This identifies returned public summary text, not an exactly recoverable pre-summary full answer.

## Limits

This ends the model loop, not Pi itself and not a running goal. Extensions can request further continuation. The completion-policy guidance is prompt text, not proof that task acceptance criteria were met.

## Test evidence

Focused child-report evidence:

- `packages/coding-agent/test/child-report.test.ts` covers current-task eligibility, durable reopen, linked parent-send evidence, rejection and public result extraction.
- `packages/coding-agent/test/suite/regressions/child-report-required.test.ts` covers inherited-history rejection, public text and narration, private/blank rejection, successful and failed contact, attached prior-task exclusion, and an actual live-child supervisor crash/restart with one later completion delivery.
- `packages/coding-agent/test/suite/regressions/child-provider-error-completion.test.ts` preserves provider failures and current-child result boundaries.

These offline faux-provider tests establish structural report enforcement and result boundaries, not live-model compliance or semantic quality.

The captured renderer, print-mode, end-turn narration and real CLI PTY tests pass. The PTY test asserts visibility before releasing a controlled tool and after reopening the persisted session in a new process. Signed blocks remain unchanged in persistence; the following provider request is also checked.

[`interactive-pty-fast-narration-output.test.ts`](../../../packages/coding-agent/test/suite/regressions/interactive-pty-fast-narration-output.test.ts) replays signed blocks from `anthropic-fast-narration.json` through fast `end_turn`, ordinary-text controls, repeated rounds, and persisted runtime mailbox acceptance. It asserts cumulative prose in emulated terminal scrollback after completion and mailbox acceptance, not just raw output bytes. Coverage is the main-view PTY; SSH/Mosh synchronization, selected-child views, and RPC/control projections are not exercised.

Existing broader coverage (not rerun for this presentation repair): [`end-turn-tool.test.ts`](../../../packages/coding-agent/test/end-turn-tool.test.ts), [`agent-loop.test.ts`](../../../packages/agent-core/test/agent-loop.test.ts), [`agent-session-prompt.test.ts`](../../../packages/coding-agent/test/suite/agent-session-prompt.test.ts), [`print-mode.test.ts`](../../../packages/coding-agent/test/print-mode.test.ts), and [`print-mode-cli.test.ts`](../../../packages/coding-agent/test/suite/print-mode-cli.test.ts) cover validation, termination/continuation, duplicate guards and printing. Resume evidence is in [`7421-resume-session-tool.test.ts`](../../../packages/coding-agent/test/suite/regressions/7421-resume-session-tool.test.ts) and [`resume-continuation-request.test.ts`](../../../packages/coding-agent/test/suite/resume-continuation-request.test.ts).
