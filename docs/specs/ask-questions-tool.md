# Ask questions tool

The `ask_questions` built-in tool lets the model ask structured multiple-choice clarifying questions during an interactive Pi session. Source lives in `packages/coding-agent/src/core/tools/ask-questions.ts`.

## What it must do

### Tool API

- [x] Expose a built-in `ask_questions` tool in the default active tool set.
- [x] Accept 1-4 unique questions, each with 2-4 unique options.
- [x] Support optional `header`, option `description`, option `preview`, `multiSelect`, and caller `metadata` fields.
- [x] Add an `Other` path automatically instead of requiring callers to include one.

### Interaction

- [x] Ask single-select questions through the interactive UI and return the selected option label.
- [x] Ask custom `Other` answers through text input and return the custom answer.
- [x] Support multi-select questions and return comma-separated selected labels.
- [x] Return a cancelled result if the user cancels before all questions are answered.
- [x] Return an error outside interactive TUI mode instead of hanging.
- [x] Send a non-expiring desktop notification while waiting for answers and close it after the question flow answers or cancels.

### Prompting and rendering

- [x] Add prompt guidance telling the model when and how to use `ask_questions`.
- [x] Render compact call/result summaries in the TUI.
- [x] Point plan-mode guidance at `ask_questions` instead of the legacy questionnaire example.

## How it works

- See [`docs/wiki/systems/ask-questions-tool.md`](../wiki/systems/ask-questions-tool.md) for future implementation notes.

## Implementation inventory

- `packages/coding-agent/src/core/tools/ask-questions.ts` — built-in tool schema, validation, UI interaction, and rendering.
- `packages/coding-agent/src/core/tools/index.ts` — built-in tool registration and default active tool list.
- `packages/coding-agent/src/index.ts` — public SDK exports.
- `packages/coding-agent/examples/extensions/plan-mode/index.ts` — plan-mode active-tool set and prompt guidance.
- `packages/coding-agent/docs/usage.md` — user-facing built-in tool list.
- `packages/coding-agent/docs/extensions.md` — extension example note for legacy questionnaire.
- `packages/coding-agent/examples/extensions/README.md` — extension example note for legacy questionnaire.

## Tests asserting this spec

- `packages/coding-agent/test/ask-questions-tool.test.ts` — default registration, validation, single-select, multi-select, custom answers, cancellation, non-TUI failure, and desktop notification lifecycle.
- `packages/coding-agent/test/plan-mode-extension.test.ts`

## Known gaps (current cycle)

- [ ] Dedicated preview-pane rendering for option `preview` content is not implemented.

## Out of scope

- HTML/Markdown preview rendering parity with Claude Code's AskUserQuestion permission component.
- Non-TUI remote/channel answer relay.
