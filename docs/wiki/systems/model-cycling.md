# Model cycling

[Contract](../../specs/model-cycling.md)

## Selection flow

`app.model.cycleForward` and `app.model.cycleBackward` default to Ctrl+P and Shift+Ctrl+P. [`interactive-mode.ts`](../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) routes them to the viewed session target, updates its footer/editor status on success, and reports an unchanged scope when cycling returns no result.

[`AgentSession.cycleModel()`](../../../packages/coding-agent/src/core/agent-session.ts) first uses its explicit `_scopedModels` array. Otherwise it resolves `settings.enabledModels` and rejects a resolved settings scope that covers every available model. It never substitutes the full available catalog for an absent scope.

The selected scope is filtered for configured auth without reordering. At most one remaining model returns `undefined`; otherwise cycling wraps forward/backward. If the current model is absent, index zero is used before applying the directional step. `setModel(..., "cycle", thinkingLevel)` applies the scoped thinking preference when supplied, otherwise the model-switch thinking policy, then clamps to the target's capabilities and emits model selection.

[`scoped-models-selector.ts`](../../../packages/coding-agent/src/modes/interactive/components/scoped-models-selector.ts) represents all enabled as `null` and an explicit ordered selection as `string[]`. Changes update session scope; explicit save persists settings. The current TUI command is `/scoped-models`, although the contract refers to `/models`. See [model catalog cache](model-catalog-cache.md) for the available-model input.

## Requirement gap

The contract says any scope covering all available models is not narrow. `_getScopedModelsForCycle()` applies that check only to settings-resolved scopes, not nonempty explicit scopes supplied through `setScopedModels`/CLI. Explicit all-model scopes therefore still cycle; the requirement is not uniformly implemented. Installed RPC documentation also describes cycling all available models; the checkout implementation above does not provide that fallback.

## Test evidence

Inspected, not run: [`agent-session-model-extension.test.ts`](../../../packages/coding-agent/test/suite/agent-session-model-extension.test.ts) covers explicit cycling/thinking preferences and settings-scope rejection when all available IDs are enabled. [`3217-scoped-model-order.test.ts`](../../../packages/coding-agent/test/suite/regressions/3217-scoped-model-order.test.ts) covers selector save, reordered callbacks and scoped-tab order.
