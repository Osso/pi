# Compaction length-retry

Module boundary: core subsystem (`packages/coding-agent/src/core/agent-session.ts`).

When an agent turn ends with `stopReason: "length"` (the provider truncated the output
mid-work) and the context is over the auto-compaction threshold, the session must compact and
then automatically resume the truncated turn instead of going idle. Without this, a session
that hits the output limit near the context ceiling compacts and silently stops, abandoning
unfinished work. How compaction itself works is described in
[compaction](../../packages/coding-agent/docs/compaction.md).

## What it must do

- [x] A post-run threshold compaction check for an assistant message with
  `stopReason: "length"` runs compaction with `willRetry: true`.
- [x] After a `willRetry` compaction, the trailing `"length"`-truncated assistant message is
  removed from agent state (it stays in session history) so `agent.continue()` resumes from
  the preceding user/tool-result message.
- [x] The resumed turn actually re-runs: the LLM is called again after compaction and its
  response is appended to the session.
- [x] Pre-prompt compaction checks (a new user prompt is being submitted) never resume a
  truncated turn; the incoming prompt supersedes it (`willRetry: false`).
- [x] At most one length-recovery attempt runs per truncated turn: a second consecutive
  `"length"`-stopped turn over the threshold compacts without resuming.
- [x] The recovery attempt guard resets when an assistant message arrives with any stop reason
  other than `"length"` (including mid-turn tool-call messages), and on the next user prompt.
- [ ] `"length"`-stopped turns with zero output tokens near the full context window are
  classified as overflow (existing overflow recovery path), not threshold length-retry.

## How it works

- [Compaction & branch summarization](../../packages/coding-agent/docs/compaction.md)
- `docs/wiki/systems/compaction-length-retry.md` (stub)

## Implementation inventory

- `packages/coding-agent/src/core/agent-session.ts` — `_checkCompaction` decides
  `willRetry` for threshold compactions; `_runAutoCompaction` strips the truncated trailing
  assistant message before the continuation; `_lengthRecoveryAttempted` guard state.
- `packages/ai/src/utils/overflow.ts` — `isContextOverflow` boundary that separates
  overflow recovery from threshold length-retry.

## Tests asserting this spec

- `packages/coding-agent/test/suite/agent-session-compaction.test.ts`
  - "requests retry when threshold compaction follows a length-truncated turn"
  - "does not retry a length-truncated turn on pre-prompt compaction checks"
  - "compacts and resumes a length-truncated turn"
  - "does not resume a second consecutive length-truncated turn"
  - "resets the length-recovery guard on the next user prompt"

## Known gaps (current cycle)

- [ ] No test pins the overflow-vs-threshold classification for `"length"` + zero-output
  messages (`isContextOverflow` case 3); behavior exists but is untested from this feature's
  angle.

## Out of scope

- Manual `/compact` after a `"length"`-stopped turn does not resume the turn;
  `_shouldContinueAfterManualCompaction` only resumes aborted/error turns or unanswered user
  messages. Extend there only if the idle-after-manual-compact case shows up in practice.
- `"length"`-stopped turns *below* the compaction threshold still end the turn without
  continuation (pre-existing behavior; compaction is not involved).
