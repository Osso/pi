# Codex Daybreak Blue

Module boundary: first-party extension module.

Codex Daybreak provides a main-thread `/daybreak` selection that adds the OpenAI Daybreak `access_programs.cyber` request parameter with value `daybreak_blue` to eligible OpenAI Codex model calls. The selection only identifies the requested access program; it does not grant entitlement. Runtime details belong in [`docs/wiki/systems/codex-daybreak.md`](../wiki/systems/codex-daybreak.md).

## What it must do

### Command behavior

- [x] Register `/daybreak` as a first-party extension command rather than a core built-in command.
- [x] `/daybreak blue` selects Blue, `/daybreak off` clears it, and bare `/daybreak` reports the current selection without persisting.
- [x] Reject any other argument, including `red`, with a usage warning and no state change.
- [x] Reject selecting Blue unless the current provider is `openai-codex`, `openai-codex-gc`, or `openai-codex-team`.
- [x] Warn when Blue is selected while the current model is not Blue-eligible.
- [x] Show `daybreak blue` in footer status when Blue applies to the current model, `daybreak blue inactive` when selected but not applicable, and nothing when off; update on model switches without changing the selection.

### Request behavior

- [x] Add `access_programs.cyber: "daybreak_blue"` only while selected, only for Codex providers, and only when the request payload model is `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, or `gpt-5.5`.
- [x] Leave requests unchanged for other models, including Red-only `gpt-6.1-sol` and `gpt-6-astra`, and for non-Codex providers.
- [x] Preserve other payload fields, including `service_tier` and other `access_programs` keys.
- [x] Warn and leave a non-object payload unchanged for that request while keeping the selection.

### Scope and lifetime

- [x] Apply only to the main runtime: child runtimes neither restore, change, nor send the selection.
- [x] Persist each accepted main-thread change as a non-LLM `codex-daybreak` custom session entry, including explicit off.
- [x] Restore the latest valid entry on main-runtime session start, ignoring unknown program values.
- [x] Preserve the selection and session identity across process `/restart` while a child is live.

## How it works

- [`docs/wiki/systems/codex-daybreak.md`](../wiki/systems/codex-daybreak.md) (stub)

## Implementation inventory

- `packages/coding-agent/extensions/codex-daybreak/src/index.ts` — handles `/daybreak`, persists and restores session state, updates footer status, and adds the access program to eligible Codex request payloads.
- `packages/coding-agent/src/main.ts` — registers the first-party extension factory.

## Tests asserting this spec

- `packages/coding-agent/test/codex-daybreak-extension.test.ts` — command, provider and model eligibility, payload, status, persistence, restore, and child-runtime behavior.
- `packages/coding-agent/test/suite/regressions/codex-daybreak-restart.test.ts` — real-process selection persistence and restored status across `/restart` with a live child.
- `packages/coding-agent/test/cli-runtime-inventory.test.ts` — first-party extension registration.

## Known gaps (current cycle)

- [ ] Acceptance of `access_programs` by the ChatGPT-authenticated Codex endpoint is unverified; tests use captured payloads only.

## Out of scope

- Daybreak Red selection; Red-only models stay unchanged.
- Child agents, the resident Supervisor, and the stateless Supervisor instruction evaluator.
- Settings defaults, automatic selection, entitlement checks, retries, model substitution, or fallback when the provider rejects a request.
