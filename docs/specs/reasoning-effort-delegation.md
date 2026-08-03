# Reasoning effort and delegation

GPT-5.6 Sol exposes maximum reasoning and automatic delegation through the first-party effort and multi-agent controls. The implementation uses the existing multi-agent runtime and prompt-context hooks; provider-specific details belong in the implementation inventory and provider tests.

## What it must do

- [x] GPT-5.6 Sol advertises `max` and `ultra` in effort selection.
- [x] `max` sends provider reasoning effort `max`.
- [x] `ultra` sends provider reasoning effort `max` and enables proactive delegation.
- [x] `/multi-agent proactive|explicit` changes delegation independently of reasoning effort.
- [x] Proactive delegation is the default.
- [x] Selecting another effort preserves delegation mode; selecting `ultra` enables proactive mode.
- [x] Delegation policy is observable in the model-facing prompt and current status.
- [x] Delegation mode persists across session reload and branch restoration.
- [x] Unsupported providers and models do not receive `max` or `ultra` unless their model metadata advertises them.

## How it works

- Existing multi-agent runtime: [`multi-agent.md`](multi-agent.md)
- Prompt policy injection: [`prompt-context-hooks.md`](prompt-context-hooks.md)

## Implementation inventory

- `packages/ai/src/types.ts` — shared effort levels.
- `packages/ai/src/models.ts` — model capability filtering and clamping.
- `packages/ai/src/providers/openai-codex.models.ts` — GPT-5.6 Sol capability metadata.
- `packages/ai/src/api/openai-codex-responses.ts` — Codex reasoning payload mapping.
- `packages/coding-agent/extensions/effort/src/index.ts` — `/effort` and `/multi-agent` commands, persistence, status, and prompt policy.
- `packages/coding-agent/src/modes/interactive/components/settings-selector.ts` — effort descriptions.

## Tests asserting this spec

- `packages/ai/test/providers.test.ts`
- `packages/ai/test/openai-codex-stream.test.ts`
- `packages/coding-agent/test/effort-extension.test.ts`
- `packages/coding-agent/test/args.test.ts`

## Known gaps (current cycle)

- [ ] Final full-project check must pass after the last implementation change.

## Out of scope

- Responses multi-agent beta fields on the ChatGPT Codex backend.
- Automatic delegation emulation for providers without multi-agent runtime support.
- Changes to unrelated providers or model catalogs.
