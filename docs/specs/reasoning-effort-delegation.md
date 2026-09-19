# Reasoning effort and delegation

GPT-5.6 Sol exposes maximum reasoning and automatic delegation through the first-party effort and multi-agent controls. `max` is provider reasoning effort; `ultra` is the Pi convenience level that sends provider maximum effort and enables proactive delegation. The implementation uses the existing multi-agent runtime and prompt-context hooks, and deliberately does not send the Responses multi-agent beta fields or beta header to the ChatGPT Codex backend.

## What it must do

- [x] GPT-5.6 Sol advertises `max` and `ultra` in effort selection.
- [x] `max` sends provider reasoning effort `max`.
- [x] `ultra` sends provider reasoning effort `max` and enables proactive delegation.
- [ ] `/multi-agent proactive|disabled` changes agent availability independently of reasoning effort.
- [ ] Proactive delegation is the default and persists as the `proactive` session value, while its footer value displays `active`.
- [ ] Disabled mode persists across session reload and active-branch restoration; absent saved state defaults to proactive.
- [ ] Disabled mode removes the Pi multi-agent policy and all active sub-agent tools (`spawn_agent`, `list_agents`, `attach_session_agent`, `wait_agent`, `close_agent`, `steer_agent`, `agent_viewer`, `send_agent_message`, and `contact_parent`) with their generated guidance. It does not cancel existing children.
- [ ] Selecting another effort preserves multi-agent mode; selecting `ultra` enables proactive mode.
- [ ] Selecting disabled mode while `ultra` is active retains maximum provider reasoning and displays `max`.
- [ ] The active delegation policy is observable in the model-facing prompt and current status; disabled mode adds no replacement delegation policy.
- [x] Unsupported providers and models do not receive `max` or `ultra` unless their model metadata advertises them.
- [x] Proactive delegation is implemented through the model-facing delegation policy, not `multi_agent.enabled`, `max_concurrent_subagents`, or `OpenAI-Beta: responses_multi_agent=v1`.
- [x] `/effort` and `/multi-agent` authorization uses the current runtime role and explicit child identity;
  historical `is_subagent` transcript provenance alone does not restrict a runtime opened as the main orchestrator.

## How it works

- Existing multi-agent runtime: [`multi-agent.md`](multi-agent.md)
- Prompt policy injection: [`prompt-context-hooks.md`](prompt-context-hooks.md)
- Spawn-contract experiment findings: [`native-ultra-spawn-contract-experiment.md`](../wiki/systems/native-ultra-spawn-contract-experiment.md)

## Implementation inventory

- `packages/ai/src/types.ts` — shared effort levels.
- `packages/ai/src/models.ts` — model capability filtering and clamping.
- `packages/ai/src/providers/openai-codex.models.ts` — GPT-5.6 Sol capability metadata.
- `packages/ai/src/api/openai-codex-responses.ts` — Codex reasoning payload mapping.
- `packages/coding-agent/extensions/effort/src/index.ts` — `/effort` and `/multi-agent` commands, defaulting, persistence, status, prompt policy, and active sub-agent tool availability.
- `packages/coding-agent/src/cli/args.ts` — CLI validation/help for `max` and `ultra`.
- `packages/coding-agent/src/core/model-registry.ts` — custom-model schema for extended effort mappings.
- `packages/coding-agent/src/core/settings-manager.ts` — persisted default-effort type support.
- `packages/coding-agent/src/modes/interactive/components/settings-selector.ts` — effort descriptions.

## Tests asserting this spec

- `packages/ai/test/providers.test.ts`
- `packages/ai/test/openai-codex-stream.test.ts`
- `packages/coding-agent/test/effort-extension.test.ts`
- `packages/coding-agent/test/args.test.ts`
- `packages/coding-agent/test/multi-agent-extension.test.ts`
- `packages/coding-agent/test/suite/regressions/multi-agent-mode-restart.test.ts`

## Known gaps (current cycle)

- [ ] Replace explicit mode with disabled mode and test the policy, active-tool surface, persisted restoration, active display label, and `ultra` re-enable behavior.

## Out of scope

- Responses multi-agent beta fields on the ChatGPT Codex backend.
- Automatic delegation emulation for providers without multi-agent runtime support.
- Changes to unrelated providers or model catalogs.
