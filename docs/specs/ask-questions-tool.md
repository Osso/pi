# Ask questions tool

The `ask_questions` built-in tool lets the model ask choice or free-text questions during an interactive Pi session. Source lives in `packages/coding-agent/src/core/tools/ask-questions.ts`.

## What it must do

### Tool API

- [x] Expose a built-in `ask_questions` tool in the default active tool set.
- [ ] Require an explicit `blocking` boolean on every call; omission is an error.
- [ ] Accept 1-4 unique questions. Optional `options`, when supplied, contains 2-4 unique choices; omission opens free-text input. Reject `multiSelect: true` without options.
- [x] Support optional `header`, option `description`, option `preview`, `multiSelect`, and caller `metadata` fields.
- [x] Add an `Other` path automatically instead of requiring callers to include one.

### Scheduling and delivery

- [ ] `blocking: true` awaits answers or cancellation and returns them in the tool result without a duplicate inbox message.
- [ ] `blocking: false` returns a queued result immediately, allowing independent authorized work to continue. Deliver answers, partial answers on cancellation, or panel failure through the runtime inbox.
- [ ] Correlate queued results and inbox messages by `requestId`, equal to the originating `toolCallId`.
- [ ] Serialize panel requests for the same UI context, including mixed blocking/nonblocking requests, without replacing an unanswered panel.
- [ ] Require a persisted session and control database for nonblocking calls; reject missing prerequisites before opening a panel.
- [ ] Route submitted nonblocking results to the originating session/agent even if the active session changes.
- [ ] Keep pending UI requests process-local like the existing panel; only submitted results enter the durable mailbox. Do not promise recovery of unanswered questions after restart.

### Interaction

- [x] Ask all questions in one tabbed panel: one tab per question plus a Submit tab when more than one question or a multi-select question is asked. A single single-select question has no tabs and returns on selection.
- [x] Move between question tabs with `app.questions.next` / `app.questions.previous` (default right/tab and left/shift+tab); up/down move within a question. Selecting an answer advances to the next tab.
- [x] Keep every answer while navigating; returning to an answered question shows the current answer and allows changing it before submitting.
- [x] Ask single-select questions through the interactive UI and return the selected option label.
- [x] Ask custom `Other` answers through inline text input and return the custom answer.
- [x] Support multi-select questions, toggled with Enter, and return comma-separated selected labels.
- [x] Submit only when every single-select choice question has an answer.
- [ ] Require nonblank trimmed free-text answers for submission; preserve drafts and allow revision across tabs. Arrow keys edit text; Tab/Shift+Tab navigate questions.
- [ ] Escape from free-text input cancels the request, retaining nonblank partial answers. Escape from Other input returns to choices.
- [x] Escape cancels and returns the answers given so far as a cancelled result.
- [x] Return an error outside interactive TUI mode instead of hanging.
- [x] Send a persistent desktop notification while waiting for answers and close it after the question flow answers or cancels.
  Persistent actionable notifications use a large non-zero timeout (`PERSISTENT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS`) because the live notification daemon treats `0` as too short; Pi still closes them explicitly by handle.

### Prompting and rendering

- [ ] Require all user questions through `ask_questions`, never chat, including free-text questions. Specify `blocking: true` when progress depends on the answer and `false` when independent work can continue.
- [x] Render compact call/result summaries in the TUI.
- [x] The transcript row lists each question and, once answered, `→ <answer>` (or `→ (cancelled)` for unanswered questions), and stays visible when `hideToolOutput` hides tool results.
- [x] Point plan-mode guidance at `ask_questions` instead of the legacy questionnaire example.

## How it works

- See [`docs/wiki/systems/ask-questions-tool.md`](../wiki/systems/ask-questions-tool.md) for implementation notes.

## Implementation inventory

- `packages/coding-agent/src/core/tools/ask-questions.ts` — built-in tool schema, validation, and transcript rendering.
- `packages/coding-agent/src/core/tools/ask-questions-panel.ts` — tabbed question panel component.
- `packages/coding-agent/src/core/keybindings.ts` — `app.questions.next` / `app.questions.previous` defaults.
- `packages/coding-agent/src/core/tools/index.ts` — built-in tool registration and default active tool list.
- `packages/coding-agent/src/index.ts` — public SDK exports.
- `packages/coding-agent/examples/extensions/plan-mode/index.ts` — plan-mode active-tool set and prompt guidance.
- `packages/coding-agent/docs/usage.md` — user-facing built-in tool list.
- `packages/coding-agent/docs/extensions.md` — extension example note for legacy questionnaire.
- `packages/coding-agent/examples/extensions/README.md` — extension example note for legacy questionnaire.

## Tests asserting this spec

- `packages/coding-agent/test/ask-questions-tool.test.ts` — default registration, validation, single-select, multi-select, custom answers, tab navigation and answer revision, cancellation, non-TUI failure, desktop notification lifecycle, and question/answer rendering with hidden tool output.
- `packages/coding-agent/test/plan-mode-extension.test.ts`
- `packages/coding-agent/test/ask-questions-async.test.ts` — required blocking, queued delivery, original recipient routing, serial panels, cancellation, and persistence prerequisite.
- `packages/coding-agent/test/ask-questions-panel-free-text.test.ts` — free-text input, drafts, required answers, cancellation, and mixed choice/multi-select panels.
- `packages/coding-agent/test/suite/ask-questions-blocking-pty.test.ts` — real TUI/model continuation and answer delivery boundary.

New contract bullets remain unchecked until their tests pass; this documentation audit did not run core tests.

## Known gaps (current cycle)

- [ ] Dedicated preview-pane rendering for option `preview` content is not implemented.

## Out of scope

- HTML/Markdown preview rendering parity with Claude Code's AskUserQuestion permission component.
- Non-TUI remote/channel answer relay.
- Durable pending-question storage or recovery of unanswered panels after restart.
