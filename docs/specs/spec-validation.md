# Spec validation command (`/spec-validation`)

Module boundary: first-party extension module.

The `/spec-validation` command asks the current Pi agent to validate every project spec independently against the `spec-format` skill. Source lives in `packages/coding-agent/extensions/spec-validation/src/index.ts`; first-party loading is wired in `packages/coding-agent/src/main.ts`. Runtime details belong in [`docs/wiki/systems/spec-validation.md`](../wiki/systems/spec-validation.md).

## What it must do

### Command lifecycle

- [x] Register `/spec-validation` with the description `Validate each docs/specs/*.md file separately`.
- [x] When the session is idle, start exactly one native agent turn with the exact validation prompt below, then clear the composer.
- [x] When the session is busy, reject `/spec-validation` with `/spec-validation is blocked while a task is running` without sending a message or clearing the composer.

The command must submit this prompt unchanged:

```text
Use the `spec-format` skill to validate every project spec separately.

Steps:

1. Find all Markdown specs under `docs/specs/` in the current project.
2. If `docs/specs/` does not exist or contains no Markdown files, report that clearly and stop.
3. For each spec file, validate it independently against the `spec-format` requirements:
   - Opening paragraph explains what the feature is and where source lives.
   - Sections appear in the expected order.
   - `What it must do` contains testable checkbox bullets.
   - Checked bullets have matching tests listed in `Tests asserting this spec`.
   - `How it works` links to wiki or architecture docs instead of duplicating implementation prose.
   - `Implementation inventory` lists source files with one-line roles.
   - `Known gaps (current cycle)` and `Out of scope` are explicit.
   - Guessed or inferred requirements are marked or omitted.
4. Produce one result block per spec with `PASS` or `FAIL`, file path, and concrete issues.
5. Do not edit files unless explicitly asked after the validation report.

```

### Native execution contract

- [x] Deliver the prompt through Pi's native agent message and continuation loop as one agent turn.
- [x] Do not implement a custom per-file dispatcher or a fallback execution path in the extension.

## How it works

- Runtime design: [`docs/wiki/systems/spec-validation.md`](../wiki/systems/spec-validation.md) (stub).
- Command registration and native message delivery: [`packages/coding-agent/docs/extensions.md`](../../packages/coding-agent/docs/extensions.md).
- Slash-command dispatch: [`slash-commands.md`](slash-commands.md).

## Implementation inventory

- `packages/coding-agent/extensions/spec-validation/package.json` — first-party extension package metadata.
- `packages/coding-agent/extensions/spec-validation/src/index.ts` — registers `/spec-validation`, gates it on idle state, submits the exact prompt, and clears the composer.
- `packages/coding-agent/src/main.ts` — loads the extension as a first-party coding-agent extension.

## Tests asserting this spec

- `packages/coding-agent/test/spec-validation-extension.test.ts` — asserts the command description, exact prompt submission, composer clearing, and busy-session rejection.
- `packages/coding-agent/test/suite/spec-validation-extension.test.ts` — exercises first-party slash-command dispatch, tool execution, and native continuation through the faux provider.

## Known gaps (current cycle)

- None.

## Out of scope

- Editing project specs automatically; the validation prompt reports findings and edits only when explicitly requested later.
- Per-file command dispatch, direct provider calls, or fallback validation paths.
- Changing the `spec-format` skill or the project specs being validated.
