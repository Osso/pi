# Model Cycling

Model cycling lets interactive users move through a deliberately scoped model
list with `Ctrl+P` and `Shift+Ctrl+P`.

## What it must do

- [x] Cycle through models configured by `--models`, `/models`, or
  `settings.enabledModels`.
- [x] Preserve scoped model order and per-model thinking-level preferences.
- [x] Never fall back to cycling all available models when no narrow model scope
  is configured.
- [x] Treat a scope that covers every available model as no narrow scope.

## Implementation inventory

- `packages/coding-agent/src/core/agent-session.ts` — model cycle behavior.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — keybinding
  handler and status messages.
- `packages/coding-agent/src/modes/interactive/components/scoped-models-selector.ts`
  — interactive model scope editor.

## Tests asserting this spec

- `packages/coding-agent/test/suite/agent-session-model-extension.test.ts`
- `packages/coding-agent/test/suite/regressions/3217-scoped-model-order.test.ts`
