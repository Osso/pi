# Codex fast mode

Module boundary: first-party extension module.

Codex fast mode provides a main-thread-owned runtime `/fast` authority that selects priority or ultrafast processing for OpenAI Codex model calls. Spawned and attached child runtimes dynamically read the same authority for later Codex requests. Runtime details belong in [`docs/wiki/systems/codex-fast-mode.md`](../wiki/systems/codex-fast-mode.md).

## What it must do

### Command behavior

- [x] Register `/fast` as a first-party extension command rather than a core built-in command.
- [x] Let bare `/fast` enable `priority` when disabled and disable fast mode when enabled; `/fast on` selects `priority`, `/fast ultra` selects `ultrafast`, and `/fast off` disables it.
- [x] Reject enabling fast mode unless the current provider is `openai-codex` or `openai-codex-gc`.
- [x] Allow only the main thread to mutate the shared authority; spawned and attached child `/fast` commands warn and leave it unchanged.
- [x] Show `fast` in footer status while enabled on a supported provider, hide it after switching away, and restore it after switching back without changing the selected tier.

### Request behavior

- [x] Read the shared authority for each provider request so main-thread `/fast on` and `/fast off` changes affect later Codex requests in spawned and attached child runtimes.
- [x] Add the selected `service_tier` (`"priority"` or `"ultrafast"`) to Codex provider request payloads while fast mode is enabled.
- [x] Leave provider request payloads unchanged while fast mode is disabled or the active provider is unsupported.
- [x] Warn and leave a non-object Codex provider payload unchanged for that request while preserving fast mode for the next valid request until explicit `/fast off`.

### Lifetime

- [x] Keep the selected tier in the shared main runtime authority across child session startup and extension reload; do not persist fast-mode state to session entries or settings.
- [x] Reset the authority to disabled on main session startup, restart, resume, or replacement.

## How it works

- [`docs/wiki/systems/codex-fast-mode.md`](../wiki/systems/codex-fast-mode.md) (stub)

## Implementation inventory

- `packages/coding-agent/extensions/codex-fast/src/index.ts` — handles `/fast`, prevents child mutation, reads shared authority for footer status and Codex request payload mutation, and resets it on main session start.
- `packages/coding-agent/src/main.ts` — creates one authority per main runtime and passes it to spawned and attached child extension runtimes.

## Tests asserting this spec

- `packages/coding-agent/test/codex-fast-extension.test.ts` — command, provider, payload, footer, and runtime-recreation behavior.
- `packages/coding-agent/test/cli-runtime-inventory.test.ts` — first-party extension registration.

## Known gaps (current cycle)

None.

## Out of scope

- Persisting fast mode across restart, resume, or session replacement.
- Applying service tiers to non-Codex providers.
- One-shot fast mode, generic service-tier controls, or pricing configuration.
