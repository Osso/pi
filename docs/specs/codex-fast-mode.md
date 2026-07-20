# Codex fast mode

Module boundary: first-party extension module.

Codex fast mode provides a runtime-local `/fast` command that requests priority processing for OpenAI Codex model calls. Runtime details belong in [`docs/wiki/systems/codex-fast-mode.md`](../wiki/systems/codex-fast-mode.md).

## What it must do

### Command behavior

- [x] Register `/fast` as a first-party extension command rather than a core built-in command.
- [x] Let bare `/fast` toggle fast mode, with explicit `/fast on` and `/fast off` forms.
- [x] Reject enabling fast mode unless the current provider is `openai-codex` or `openai-codex-gc`.
- [x] Show `fast` in footer status while enabled on a supported provider, hide it after switching away, and restore it after switching back without changing the runtime toggle.

### Request behavior

- [x] Add `service_tier: "priority"` to Codex provider request payloads while fast mode is enabled.
- [x] Leave provider request payloads unchanged while fast mode is disabled or the active provider is unsupported.
- [x] Warn and leave a non-object Codex provider payload unchanged for that request while preserving fast mode for the next valid request until explicit `/fast off`.

### Lifetime

- [x] Keep fast mode only in the current extension runtime until explicitly disabled.
- [x] Start disabled after runtime recreation, including restart or resume; do not write fast-mode state to session entries or settings.

## How it works

- [`docs/wiki/systems/codex-fast-mode.md`](../wiki/systems/codex-fast-mode.md) (stub)

## Implementation inventory

- `packages/coding-agent/extensions/codex-fast/src/index.ts` — owns runtime-local state, `/fast`, footer status, and Codex request payload mutation.
- `packages/coding-agent/src/main.ts` — registers the first-party extension.

## Tests asserting this spec

- `packages/coding-agent/test/codex-fast-extension.test.ts` — command, provider, payload, footer, and runtime-recreation behavior.
- `packages/coding-agent/test/cli-runtime-inventory.test.ts` — first-party extension registration.

## Known gaps (current cycle)

None.

## Out of scope

- Persisting fast mode across restart, resume, or session replacement.
- Applying priority service tiers to non-Codex providers.
- One-shot fast mode, generic service-tier controls, or pricing configuration.
