# Duplicate-turn loop guard

Module boundary: `AgentSession` runtime behavior. Pi detects consecutive identical assistant turns, injects a runtime-only instruction to stop looping with `end_turn`, and terminates the repeated loop if the model ignores that instruction. The runtime details live in [`docs/wiki/systems/duplicate-turn-guard.md`](../wiki/systems/duplicate-turn-guard.md).

## What it must do

### Detection

- [x] Compare consecutive assistant turns deterministically using assistant content and stop reason.
- [x] Consider only assistant turns without tool calls and exclude error or aborted turns.
- [x] Detect the second consecutive turn with the same fingerprint (`agent-session-prompt.test.ts`).

### Guard instruction

- [x] Keep the built-in `end_turn` control tool active even when no tools, no built-in tools, an explicit allowlist, or an exclusion list would otherwise remove it (`2835-tools-allowlist-filters-extension-tools.test.ts`, `3592-no-builtin-tools-keeps-extension-tools.test.ts`, `5109-exclude-tools.test.ts`).
- [x] Inject a user-role steering instruction telling the model to stop looping and call `end_turn` with a concise reason (`agent-session-prompt.test.ts`).
- [x] Inject the instruction at most once for the current duplicate-turn sequence.
- [x] Terminate the current repeated-turn loop when the model repeats after the guard, so callers do not consume their request deadline (`agent-session-prompt.test.ts`).
- [x] When the guard-generated terminal `end_turn` ends a Supervisor request, use the last completed JSON response from that same current request; never reuse a response from an earlier request (`supervisor-service.test.ts`).
- [x] Keep the injected instruction out of persisted session history (`agent-session-prompt.test.ts`).

### Presentation

- [x] Hide the duplicate assistant response that triggers the guard from live InteractiveMode chat while preserving the message in runtime context and session persistence (`interactive-mode-streaming-render-throttle.test.ts`, `agent-session-prompt.test.ts`).
- [x] Hide the internal `end_turn` guard nudge from live InteractiveMode and resident-console chat (`interactive-mode-streaming-render-throttle.test.ts`, `resident-console-command.test.ts`).

### Reset behavior

- [x] Reset detection when assistant content changes (`agent-session-prompt.test.ts`).
- [x] Reset detection when tool execution starts (`agent-session-prompt.test.ts`).
- [x] Reset detection when non-synthetic user input starts (`agent-session-prompt.test.ts`).

## How it works

- Runtime state, fingerprinting, reset conditions, and persistence exclusion: [`docs/wiki/systems/duplicate-turn-guard.md`](../wiki/systems/duplicate-turn-guard.md).

## Implementation inventory

- `packages/coding-agent/src/core/agent-session.ts` — tracks assistant fingerprints, marks presentation-only duplicate messages, injects the runtime-only guard message, emits marker metadata, resets detection, and excludes synthetic messages from persistence.
- `packages/coding-agent/src/core/runtime-message-markers.ts` — owns runtime-only message identity markers used by local and transported presentation paths.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — hides marked duplicate assistant output and guard nudges from live chat.
- `packages/coding-agent/src/cli/resident-console-command.ts` — applies the same live-chat filtering to resident-console events.
- `packages/coding-agent/test/suite/agent-session-prompt.test.ts` — verifies injection, child-runtime coverage, persistence exclusion, and reset behavior.
- `packages/coding-agent/test/suite/regressions/2835-tools-allowlist-filters-extension-tools.test.ts` — verifies allowlists preserve `end_turn`.
- `packages/coding-agent/test/suite/regressions/3592-no-builtin-tools-keeps-extension-tools.test.ts` — verifies no-tools and no-builtin-tools preserve `end_turn`.
- `packages/coding-agent/test/suite/regressions/5109-exclude-tools.test.ts` — verifies exclusions preserve `end_turn`.

## Tests asserting this spec

- `packages/coding-agent/test/suite/agent-session-prompt.test.ts` — duplicate-turn guard, marker emission, and reset regressions.
- `packages/coding-agent/test/interactive-mode-streaming-render-throttle.test.ts` — InteractiveMode live rendering filters.
- `packages/coding-agent/test/resident-console-command.test.ts` — resident-console live rendering filters.

## Known gaps (current cycle)

None.

## Out of scope

- Fuzzy or semantic similarity detection.
- Detecting duplicate tool calls or duplicate tool results.
- Persisting the synthetic guard instruction as a user message.
- Suppressing ordinary tools from explicit allowlists, no-tools settings, or exclusion lists.
- Replacing the existing `end_turn` tool contract or retry/compaction behavior.
