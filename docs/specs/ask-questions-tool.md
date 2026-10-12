# Ask questions tool

The `ask_questions` built-in tool lets the model ask choice or free-text questions during an interactive Pi session. Source lives in `packages/coding-agent/src/core/tools/ask-questions.ts`.

## What it must do

### Tool API

- [x] Expose a built-in `ask_questions` tool in the default active tool set.
- [x] Require an explicit `blocking` boolean on every call; omission is an error.
- [x] Accept 1-4 unique questions. Optional `options`, when supplied, contains 2-4 unique choices; omission opens free-text input. Reject `multiSelect: true` without options.
- [x] Support optional `header`, option `description`, option `preview`, `multiSelect`, and caller `metadata` fields.
- [x] Add an `Other` path automatically instead of requiring callers to include one.

### Scheduling and delivery

- [x] `blocking: true` awaits answers or cancellation and returns them in the tool result without a duplicate inbox message.
- [x] `blocking: false` returns a queued result immediately, allowing independent authorized work to continue. Deliver answers, partial answers on cancellation, or panel failure through the runtime inbox.
- [x] Correlate queued results and inbox messages by `requestId`, equal to the originating `toolCallId`.
- [x] Serialize panel requests for the same UI context, including mixed blocking/nonblocking requests, without replacing an unanswered panel.
- [x] Restore a pending question and its keyboard focus after an intervening extension selector/confirm, input, editor, or non-overlay custom dialog closes. Answering the restored nonblocking question must deliver its correlated inbox reply and allow later queued questions to progress.
- [x] Require a persisted session and control database for nonblocking calls; reject missing prerequisites before opening a panel.
- [x] Route submitted nonblocking results to the originating session/agent even if the active session changes.
- [x] Keep pending UI requests process-local like the existing panel; only submitted results enter the durable mailbox. Do not promise recovery of unanswered questions after restart.

### Child-agent relay

- [x] In a child agent runtime, `ask_questions` sends the questions to the direct parent through the `contact_parent` mailbox path instead of failing for lack of a TUI. The parent message names the child agent ID, the `requestId` (the child's `toolCallId`), whether the child is blocked, and each question with header, options, and multi-select/free-text form.
- [x] The parent answers with `answer_question { agentId, requestId, answers, cancelled? }`. It accepts only an active direct child of the caller and enqueues one correlated reply; `answers` is keyed by exact question text.
- [x] A blocking child call waits without model calls until that correlated reply arrives, then returns it as the original `ask_questions` result (`Parent answered questions:` or `Parent cancelled questions:`) with structured `answers`/`cancelled` details. The reply is accepted into the child transcript with the tool result and never redelivered as an inbox prompt.
- [x] A nonblocking child call returns a queued result immediately; the parent's reply arrives through the child's normal inbox as an `ask_questions_answer` JSON message correlated by `requestId`.
- [x] Aborting the child while it waits ends the wait; the core replaces the result with `Agent run aborted`.
- [x] Main-runtime `ask_questions` behavior is unchanged. `answer_question` is excluded from child runtimes (children cannot own children), standalone runtimes, and the multi-agent-disabled tool surface. Profiles with a `tools` allowlist always retain `ask_questions`.
- Pending child questions are process-local, like pending panels: a waiting child whose runtime restarts does not resume the wait.

### Interaction

- [x] Ask all questions in one tabbed panel: one tab per question plus a Submit tab when more than one question or a multi-select question is asked. A single single-select question has no tabs and returns on selection.
- [x] Move between question tabs with `app.questions.next` / `app.questions.previous` (default right/tab and left/shift+tab); up/down move within a question. Selecting an answer advances to the next tab.
- [x] Keep every answer while navigating; returning to an answered question shows the current answer and allows changing it before submitting.
- [x] Ask single-select questions through the interactive UI and return the selected option label.
- [x] Ask custom `Other` answers through inline text input and return the custom answer.
- [x] Support multi-select questions, toggled with Enter, and return comma-separated selected labels.
- [x] Submit only when every single-select choice question has an answer.
- [x] Require nonblank trimmed free-text answers for submission; preserve drafts and allow revision across tabs. Arrow keys edit text; Tab/Shift+Tab navigate questions.
- [x] Escape from free-text input cancels the request, retaining nonblank partial answers. Escape from Other input returns to choices.
- [x] Escape cancels and returns the answers given so far as a cancelled result.
- [x] Return an error outside interactive TUI mode instead of hanging.
- [x] Send a persistent desktop notification while waiting for answers and close it after the question flow answers or cancels.
  Persistent actionable notifications use a large non-zero timeout (`PERSISTENT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS`) because the live notification daemon treats `0` as too short; Pi still closes them explicitly by handle.

### Prompting and rendering

- [x] Require all user questions through `ask_questions`, never chat, including free-text questions. Specify `blocking: true` when progress depends on the answer and `false` when independent work can continue.
- [x] Render compact call/result summaries in the TUI.
- [x] The transcript row lists each question and, once answered, `→ <answer>` (or `→ (cancelled)` for unanswered questions), and stays visible when `hideToolOutput` hides tool results.
- [x] Point plan-mode guidance at `ask_questions` instead of the legacy questionnaire example.

## How it works

- See [`docs/wiki/systems/ask-questions-tool.md`](../wiki/systems/ask-questions-tool.md) for implementation notes.

## Implementation inventory

- `packages/coding-agent/src/core/tools/ask-questions.ts` — built-in tool schema, validation, and transcript rendering.
- `packages/coding-agent/extensions/agents-core/src/question-relay-tools.ts` — child-runtime `ask_questions` relay and parent `answer_question` tool, registered by `agents-mailbox`.
- `packages/coding-agent/src/core/tools/ask-questions-panel.ts` — tabbed question panel component.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — extension dialogs restore the prior editor-container contents and focus.
- `packages/coding-agent/src/modes/interactive/editor-dialog-restore.ts` — captures editor-container children and keyboard focus for restoration.
- `packages/coding-agent/src/core/keybindings.ts` — `app.questions.next` / `app.questions.previous` defaults.
- `packages/coding-agent/src/core/tools/index.ts` — built-in tool registration and default active tool list.
- `packages/coding-agent/src/index.ts` — public SDK exports.
- `packages/coding-agent/examples/extensions/plan-mode/index.ts` — plan-mode active-tool set and prompt guidance.
- `packages/coding-agent/docs/usage.md` — user-facing built-in tool list.
- `packages/coding-agent/docs/extensions.md` — extension example note for legacy questionnaire.
- `packages/coding-agent/examples/extensions/README.md` — extension example note for legacy questionnaire.

## Tests asserting this spec

- `packages/coding-agent/test/suite/child-ask-questions.test.ts` — child-to-parent relay through real parent/child sessions and control DB: blocking answer resumes the original tool call, nonblocking inbox delivery, abort, main-runtime delegation, and non-parent rejection.

- `packages/coding-agent/test/ask-questions-tool.test.ts` — default registration, validation, single-select, multi-select, custom answers, tab navigation and answer revision, cancellation, non-TUI failure, desktop notification lifecycle, and question/answer rendering with hidden tool output.
- `packages/coding-agent/test/plan-mode-extension.test.ts`
- `packages/coding-agent/test/ask-questions-async.test.ts` — required blocking, queued delivery, original recipient routing, serial panels, cancellation, and persistence prerequisite.
- `packages/coding-agent/test/ask-questions-panel-free-text.test.ts` — free-text input, drafts, required answers, cancellation, and mixed choice/multi-select panels.
- `packages/coding-agent/test/suite/ask-questions-blocking-pty.test.ts` — real TUI/model continuation, answer delivery, and intervening confirm restoration with correlated durable inbox replies and later queue progress.
- `packages/coding-agent/test/suite/fixtures/ask-questions-confirm-extension.ts` — extension tool opening the intervening `ctx.ui.confirm` in the PTY regression.

Acceptance at `51735c8ec`: independent verification inspected 43 passing feature tests (31 async/tool/plan-mode, 9 free-text, 3 real-PTY) and a passing `npm run check`. Confirm interruption has real-process RED/GREEN proof; input/editor/non-overlay custom restoration is source-inspected, not separately proven by the new PTY test. Prompt and persistent-rule inspection proves tool-only instructions, not guaranteed model compliance.

## Known gaps (current cycle)

- [ ] Dedicated preview-pane rendering for option `preview` content is not implemented.

## Out of scope

- HTML/Markdown preview rendering parity with Claude Code's AskUserQuestion permission component.
- Non-TUI remote/channel answer relay other than the child-to-parent relay.
- Durable pending-question storage or recovery of unanswered panels after restart.
