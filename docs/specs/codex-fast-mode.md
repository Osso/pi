# Codex fast mode

Module boundary: first-party extension module.

Codex fast mode provides a main-thread-owned runtime `/fast` authority that selects priority or ultrafast processing for OpenAI Codex model calls. Spawned and attached child runtimes dynamically read the same authority for later Codex requests. Runtime details belong in [`docs/wiki/systems/codex-fast-mode.md`](../wiki/systems/codex-fast-mode.md).

## What it must do

### Command behavior

- [x] Register `/fast` as a first-party extension command rather than a core built-in command.
- [x] Let bare `/fast` enable `priority` when disabled and disable fast mode when enabled; `/fast on` selects `priority`, `/fast ultra` selects `ultrafast`, and `/fast off` disables it.
- [x] Reject enabling fast mode unless the current provider is `openai-codex` or `openai-codex-gc`.
- [x] Allow only the current main/orchestrator runtime to mutate the shared authority; spawned and attached
  child `/fast` commands warn and leave it unchanged. Explicit runtime child identity is authoritative;
  historical `is_subagent` transcript provenance alone does not classify a runtime opened as main.
- [x] Show `fast` in footer status while enabled on a supported provider, hide it after switching away, and restore it after switching back without changing the selected tier.

### Request behavior

- [x] Read the shared authority for each provider request so main-thread `/fast on` and `/fast off` changes affect later Codex requests in spawned and attached child runtimes.
- [x] Add the selected `service_tier` (`"priority"` or `"ultrafast"`) to Codex provider request payloads while fast mode is enabled.
- [x] Leave provider request payloads unchanged while fast mode is disabled or the active provider is unsupported.
- [x] Warn and leave a non-object Codex provider payload unchanged for that request while preserving fast mode for the next valid request until explicit `/fast off`.

### Lifetime

- [x] Persist each accepted main-thread `/fast` change as a non-LLM `codex-fast-mode` custom session entry, including explicit off.
- [x] Restore the latest valid fast-mode entry when the main runtime opens the same session; child session startup must not overwrite the shared authority, and sessions without a fast-mode entry start disabled.
- [x] Preserve the selected tier and session identity across process `/restart`.

## How it works

- [`docs/wiki/systems/codex-fast-mode.md`](../wiki/systems/codex-fast-mode.md) (stub)

## Implementation inventory

- `packages/coding-agent/extensions/codex-fast/src/index.ts` — handles `/fast`, persists and restores session state, prevents child mutation, and reads shared authority for footer status and Codex request payload mutation.
- `packages/coding-agent/src/main.ts` — creates one authority per main runtime and passes it to spawned and attached child extension runtimes.

## Tests asserting this spec

- `packages/coding-agent/test/codex-fast-extension.test.ts` — command, persistence, provider, payload, footer, child-authority, and runtime-recreation behavior.
- `packages/coding-agent/test/suite/regressions/codex-fast-restart.test.ts` — real-process `/restart` preservation.
- `packages/coding-agent/test/cli-runtime-inventory.test.ts` — first-party extension registration.

## Known gaps (current cycle)

None.

## Out of scope

- Global fast-mode state shared across unrelated sessions.
- Applying service tiers to non-Codex providers.
- One-shot fast mode, generic service-tier controls, or pricing configuration.
