# Duplicate-turn loop guard

Module boundary: `AgentSession` runtime behavior. Pi detects consecutive identical assistant turns and injects a runtime-only instruction to stop looping with `end_turn`. The runtime details live in [`docs/wiki/systems/duplicate-turn-guard.md`](../wiki/systems/duplicate-turn-guard.md).

## What it must do

### Detection

- [x] Compare consecutive assistant turns deterministically using assistant content and stop reason.
- [x] Consider only assistant turns without tool calls and exclude error or aborted turns.
- [x] Detect the second consecutive turn with the same fingerprint (`agent-session-prompt.test.ts`).

### Guard instruction

- [x] Inject a user-role steering instruction telling the model to stop looping and call `end_turn` with a concise reason (`agent-session-prompt.test.ts`).
- [x] Inject the instruction at most once for the current duplicate-turn sequence.
- [x] Keep the injected instruction out of persisted session history (`agent-session-prompt.test.ts`).

### Reset behavior

- [x] Reset detection when assistant content changes (`agent-session-prompt.test.ts`).
- [x] Reset detection when tool execution starts (`agent-session-prompt.test.ts`).
- [x] Reset detection when non-synthetic user input starts (`agent-session-prompt.test.ts`).

## How it works

- Runtime state, fingerprinting, reset conditions, and persistence exclusion: [`docs/wiki/systems/duplicate-turn-guard.md`](../wiki/systems/duplicate-turn-guard.md).

## Implementation inventory

- `packages/coding-agent/src/core/agent-session.ts` — tracks assistant fingerprints, injects the runtime-only guard message, resets detection, and excludes synthetic messages from persistence.
- `packages/coding-agent/test/suite/agent-session-prompt.test.ts` — verifies injection, persistence exclusion, and reset behavior.

## Tests asserting this spec

- `packages/coding-agent/test/suite/agent-session-prompt.test.ts` — duplicate-turn guard and reset regressions.

## Known gaps (current cycle)

None.

## Out of scope

- Fuzzy or semantic similarity detection.
- Detecting duplicate tool calls or duplicate tool results.
- Persisting the synthetic guard instruction as a user message.
- Replacing the existing `end_turn` tool contract or retry/compaction behavior.
