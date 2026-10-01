# Reasoning effort and delegation

[Contract](../../specs/reasoning-effort-delegation.md).

## Effort to request

[Shared types](../../../packages/ai/src/types.ts) include `max` and `ultra`. [Model capability helpers](../../../packages/ai/src/models.ts) advertise extended levels only when `thinkingLevelMap` supplies them, hide explicit `null` mappings, and clamp unsupported selections. Non-reasoning models offer only `off`.

[Codex model metadata](../../../packages/ai/src/providers/openai-codex.models.ts) maps GPT-5.6 Sol `max` and `ultra` to provider `max`. [Codex request code](../../../packages/ai/src/api/openai-codex-responses.ts) clamps simple reasoning options, applies the model mapping, and writes `body.reasoning.effort`. `ultra` is therefore a Pi selection, not a distinct Sol wire effort. CLI parsing, custom-model validation, and saved defaults are implemented in [args.ts](../../../packages/coding-agent/src/cli/args.ts), [model-registry.ts](../../../packages/coding-agent/src/core/model-registry.ts), and [settings-manager.ts](../../../packages/coding-agent/src/core/settings-manager.ts).

## Delegation state

The [effort extension](../../../packages/coding-agent/extensions/effort/src/index.ts) registers `/effort` and `/multi-agent proactive|disabled`. Delegation defaults to `proactive`, displayed as `active`. Changes append a `multi-agent-mode` custom entry; `session_start` and `session_tree` reconstruct mode from the active branch.

Selecting `ultra` enables proactive delegation. Other effort selections preserve mode. Disabling while `ultra` is selected changes the displayed effort to `max`, preserving maximum provider reasoning. Main-runtime identity controls delegation authorization; historical transcript subagent provenance is not the gate. Explicit child runtimes do not control the main delegation policy.

Proactive mode adds a marked policy through `before_agent_start`. Disabled mode removes that policy and the active subagent orchestration, viewer, and mailbox tools. Re-enabling restores tools remembered as removed, without replacing unrelated selections. Disabling does not cancel live children. Pyrun bridge methods remain subject to active-tool availability.

## Boundaries

Delegation is model-facing policy plus Pi tool availability, not a scheduler guarantee that every prompt spawns children. Codex requests do not use Responses multi-agent beta fields or the multi-agent beta header. Other models need explicit capability metadata for extended efforts. Persistence is branch-entry restoration, not an independent global delegation setting. No unimplemented behavior identified in the inspected effort path.

## Test evidence

Tests inspected, not run: [effort-extension.test.ts](../../../packages/coding-agent/test/effort-extension.test.ts) covers supported choices, policy/tool changes, persistence, and runtime-role gating. [Codex stream tests](../../../packages/ai/test/openai-codex-stream.test.ts) capture actual serialized Sol `max`/`ultra` requests. [Restart regression](../../../packages/coding-agent/test/suite/regressions/multi-agent-mode-restart.test.ts) disables delegation with a live child, restarts the supervisor, and asserts hidden tools plus eventual child completion. Additional locations: [CLI tests](../../../packages/coding-agent/test/args.test.ts) and [multi-agent tests](../../../packages/coding-agent/test/multi-agent-extension.test.ts).
