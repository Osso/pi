# End-turn tool

The built-in `end_turn` tool gives normal coding-agent model turns an explicit completion signal. It is active by default; model turns continue after assistant text without tool calls until a terminating `end_turn` tool batch is executed. How the loop applies this signal belongs in [`docs/wiki/systems/end-turn-tool.md`](../wiki/systems/end-turn-tool.md).

## What it must do

### Tool contract

- [x] Register a built-in `end_turn` tool in the default active tool set.
- [x] Require one nonblank free-form `reason` argument and reject a blank reason.
- [x] Instruct the model to keep working while actionable task work remains and call `end_turn` only after completion, when progress requires user input, or when the user explicitly asks it to stop.
- [x] Instruct the model that thinking is never shown to the user, so a reply must be written as assistant text before `end_turn`.
- [x] Accept otherwise valid `end_turn` calls alongside signed public narration without rejecting the response or requesting model regeneration; presentation follows the [public-narration contract](assistant-narration.md).
- [x] Return a terminating tool result when execution succeeds.

### Child report requirement

- [x] Require spawned and attached children to report before successful completion, both when `end_turn` executes and when the current dispatch returns: accept nonblank public assistant text (ordinary text or server-signed public narration), or a successful `contact_parent` result linked to its current tool call with a nonblank `body`, a nonblank message ID, and status `pending`, `claimed`, or `accepted`. A failed transport result does not qualify even when `isError` is false.
- [x] Use only the durable current branch after the latest user prompt. Exclude inherited parent history, prior-task reports, private thinking, whitespace, and failed contact attempts; reconstruct eligibility after restart without new persistent state.
- [x] Reject reportless child `end_turn` with an actionable error and no termination so the child can report. Apply the same guard to both child factories, without an opt-out, compatibility path, fallback, or model gate. Normal main-session textless `end_turn` remains unchanged.
- [x] Validate the final current-dispatch result with the same report predicate after a normal prompt return, including a terminal provider `length` response that bypasses `end_turn`. Without a report, throw an explicit error so the child becomes `failed` and the parent receives an error notification, never reportless `completed`. Successful `contact_parent` evidence can qualify without assistant text. Preserve original provider errors and cancellation as `aborted`; do not add retries, a length-specific fallback, or a new lifecycle state.
- [x] Include accepted public narration in parent result extraction through the existing public-text helper. Final validation excludes previous-dispatch reports even when they remain eligible for the current-task tool guard.

### Agent loop

- [x] In print mode (`pi -p`), print the final assistant text from the current prompt when `end_turn` completes either in the same response or a subsequent textless response; never reuse text from an earlier prompt. Preserve JSON output and nonzero error exits.
- [x] Continue a normal coding-agent model run after an assistant response containing text but no tool call when `end_turn` is available.
- [x] Before an uninterrupted immediate continuation request, append a runtime-only user instruction stating that the prior response was already delivered, that the model must not continue, repeat, or infer a new user request, and that it must call `end_turn` with a concise reason. Real steering queued before that request supersedes the instruction. The instruction is not emitted as an event, returned in `newMessages`, or persisted.
- [x] End the run after a tool batch whose finalized results all request termination, including `end_turn`.
- [x] Keep model errors, aborted turns, provider `"length"` truncation, and existing explicit termination mechanisms terminal.
- [x] Treat a persisted assistant tool batch with a successful `end_turn` result as clean completion during resume; it stays idle unless an extension requests one continuation, while interrupted turns still use the existing continuation predicate.
- [x] Detect consecutive identical text-only assistant turns at the AgentSession boundary and inject one non-persisted instruction to call `end_turn` with a concise reason; changed content, tool execution, and new user input reset detection.

## How it works

- [`docs/wiki/systems/end-turn-tool.md`](../wiki/systems/end-turn-tool.md).

## Implementation inventory

- `packages/coding-agent/src/core/tools/end-turn.ts` — defines the built-in tool schema and terminating result.
- `packages/coding-agent/src/core/tools/index.ts` — exports and registers the tool in default tool collections.
- `packages/coding-agent/extensions/agents-core/src/runtime.ts` — installs the child-only `end_turn` guard through `customTools` in both spawned and attached factories.
- `packages/coding-agent/extensions/agents-core/src/child-report.ts` — reconstructs current-task report eligibility from the persisted branch and rejects reportless completion.
- `packages/coding-agent/extensions/agents-core/src/child-response.ts` — extracts current-dispatch public assistant text, including signed public narration, and is the terminal report-validation boundary; original provider errors remain unchanged.
- `packages/coding-agent/src/core/assistant-narration.ts` — shared public-text classification for signed narration.
- `packages/agent-core/src/agent-loop.ts` — continues text-only responses when the end-turn tool is available, unless pending steering takes precedence.
- `packages/coding-agent/src/core/agent-session.ts` — detects duplicate assistant turns, injects the runtime-only loop guard, and distinguishes completed persisted `end_turn` batches from interrupted turns during resume.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` and `packages/coding-agent/src/modes/rpc/rpc-mode.ts` — consume one-shot extension continuation requests before startup or session-switch continuation.

## Tests asserting this spec

- `packages/coding-agent/test/child-report.test.ts` — report eligibility, rejection, and current-dispatch extraction.
- `packages/coding-agent/test/suite/regressions/child-report-required.test.ts` — real-process spawned/attached guards, public narration, failed contact rejection, terminal report validation, and live-child supervisor crash/restart with one later completion delivery.
- `packages/coding-agent/test/suite/regressions/child-provider-error-completion.test.ts` — real-process provider failures and current-child result boundaries.
- `packages/coding-agent/test/end-turn-tool.test.ts`
- `packages/coding-agent/test/suite/end-turn-summarized-reply.test.ts`
- `packages/coding-agent/test/print-mode.test.ts`
- `packages/coding-agent/test/suite/print-mode-cli.test.ts`
- `packages/agent-core/test/agent-loop.test.ts`
- `packages/coding-agent/test/suite/agent-session-prompt.test.ts`
- `packages/coding-agent/test/suite/regressions/7421-resume-session-tool.test.ts`
- `packages/coding-agent/test/suite/resume-continuation-request.test.ts`

## Known gaps (current cycle)

Terminal result validation must enforce the structural report contract even when no `end_turn` executes. See the [evidence scope](../wiki/systems/end-turn-tool.md#test-evidence).

## Out of scope

- Semantic quality or correctness of model findings and live-model compliance: the guard checks report presence and successful send evidence only.
- Automatic report generation, policy evaluation, or extra persistent report state.
- Goal continuation policy and `/goal` lifecycle decisions.
- Resident Supervisor review or completion policy.
- Replacing existing abort, error, steering, or explicit stop-hook behavior.
