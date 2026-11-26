# User questions

Module boundary: core subsystem.

User questions let a person send a durable question to a running main Pi session and read the agent's answer outside the transcript. Source lives in `packages/coding-agent/src/user-questions/`, `packages/coding-agent/src/core/tools/answer-user-question.ts`, and the `pi questions` CLI in `packages/coding-agent/src/cli/questions-*.ts`.

## What it must do

### Central storage

- [x] Store question ID, parent ID, target host/session, question, status, answer, creation time, and answer time in the host control database.
- [x] List questions newest first and read one question by ID.
- [x] Accept answer revisions and update the answer time; report an unknown ID to the caller.
- [x] Remove question rows after three days, regardless of status.
- [x] The store lives on the configured Supervisor host (the local host when `supervisor.host` is unset or local). `pi questions` and `pi control questions` refuse to run on any other host.

### Asking and answering

- [x] `askUserQuestion` delivers a user question to a running main session through its runtime mailbox, through the relay for a session on another host, and wakes an idle session.
- [x] The target answers with `answer_user_question { id, answer }`. Reject blank answers and record the answer centrally.
- [x] For remote stores, relay the answer to the Supervisor host and record it there without requiring the Supervisor session to run. An answer to an expired question is logged and dropped.
- [x] Allow follow-up questions. A follow-up targets the original question's session and includes the earlier question and answer in the delivered message.
- [x] Render a compact transcript row that includes the answer.
- [x] Exclude `answer_user_question` from child-agent runtimes.

### `pi questions` CLI

One view of both directions on the store host: these user questions and the agent questions stored by the Supervisor ([Supervisor question answering](supervisor-service.md#question-answering)). References are `u<id>` for user questions and `a<id>` for agent questions.

- [x] `pi questions` is an interactive terminal view, usable over SSH and as a remote-agent managed session (`pi_args: ["questions"]`). It lists unanswered questions (waiting for the user, the Supervisor, or the asked agent) newest first; `app.questions.toggleAll` (default tab) switches to all questions of the last three days and back; the title names the view. The list has no ask or refresh action rows; `app.questions.new` (default Ctrl+N) starts asking a session, and `app.questions.refresh` (default Ctrl+R) reloads the visible list in place, keeping the selected question, and refreshes remote names. The footer shows these key hints and wraps whole hints onto another line when the terminal is too narrow. Quit stays below a table with a header row and aligned columns: ref, direction (`→ you` for an agent's question, `you →` for the user's), state (open, supervisor, answered, cancelled, each in its theme color), age (`now`, `5m`, `3h`, `2d`), session (the name for a named local session, or the returned name for a remote session already present in stored questions; load remote names asynchronously with one bounded name-only query per host on list load or Refresh, coalescing Refresh while a lookup is in flight, never read transcript/cwd/goal, and keep `host:short-id` while unavailable or unnamed), question, answer source, and answer (an agent question's chosen answers, or the agent's answer to a user question). In the list, show `you` for stored `user`/`local` answers, `Supervisor` for a stored Supervisor source, `Agent` for answered user questions (their durable answer contract records answers from the agent tool or its relay, but not a specific agent identity), and `unknown` when an agent-question record does not prove who answered. New Supervisor answers persist the explicit `supervisor` source. Historical agent answers without a source remain `unknown`. Column widths fit the terminal width: the question column takes the remaining space, long cells are clipped with an ellipsis, and no line is wider than the terminal. Up/down (and `app.questions.listUp`/`listDown`, default k/j) move the selection across question rows and Quit, including when the list is empty; long lists scroll, Enter opens a detail view with aligned Question / Answer / Source / Session / Asked lines; its source uses the stored value rather than the list label. Escape returns from detail and answer panels to the list. A fresh Escape on the list quits; repeated cancel key events do not quit. It shows each answered agent question with its chosen answers and their source (and revision time) in the list and a detail view before an explicit "Revise the answer", offers an answer for a question cancelled without one, answers or revises an agent question in the `ask_questions` panel, shows an agent's full answer to a user question with an "Ask a follow-up" action, and asks a new question of a running local session, a remote session seen in stored questions, or a typed `host:session-id`.
- [x] `pi questions` resolves remote names only for session IDs already present in stored question rows. It sends one asynchronous, name-only relay request per host on list load or Refresh; names appear without a host prefix, and detail views keep the host and session ID. If a peer is old, unavailable, or returns no name, keep `host:short-id` without a warning. Never read remote transcripts, cwd, or goals for this display, and do not replicate or persist broad remote metadata.
- [x] While the unanswered list is visible, refresh stored rows every two seconds in place. Preserve the selected question reference or a Quit selection chosen while questions were listed, and the scroll position; if the selected question disappears, select the first row. When the first question arrives in an empty list, select it. Do not refresh automatically in all-history mode or while a detail, answer, ask, or follow-up panel is visible. Stop the timer on quit, and resolve names for newly seen remote IDs without repeating lookups on each tick. Keep manual refresh with `app.questions.refresh`.
- [x] `pi control questions list [--json]`, `answer <a-ref> <answer>` / `answer <a-ref> --json <answers>`, `ask <session-id> [--host <host>] <question>`, and `follow-up <u-ref> <question>` give the same operations without a terminal UI, for scripts and a future mobile service. Human-readable output uses `Agent` for answered user questions and marks agent-question answers without a proven source as `unknown`; JSON preserves only attribution stored in the record. Errors exit with status 1 and a message.
- [x] `/ask <session-id-prefix> <question>` in an interactive session on the store host asks the one session whose ID starts with the prefix; bare `/ask` picks the session from the same targets as `pi questions` (except the current session) and then reads the question. It reports the new `u<ref>`; the answer shows in `pi questions`. An unknown or ambiguous prefix, a missing question, or a session off the store host is reported and stores nothing.
- [x] `answer` on an agent question waiting for the user answers it; on an answered question it revises it; on a question cancelled without an answer it answers it and sends the answer to the asker as a message. Answers must cover exactly the asked questions.

## Implementation inventory

- `packages/coding-agent/src/core/session-control-db/user-questions.ts` — stored question operations.
- `packages/coding-agent/src/user-questions/ask.ts` — question insertion and mailbox delivery.
- `packages/coding-agent/src/core/tools/answer-user-question.ts` — answer tool.
- `packages/coding-agent/src/core/host-relay-store.ts` — remote answer import.
- `packages/coding-agent/src/core/session-control-db/connection.ts` — three-day retention.
- `packages/coding-agent/src/questions/question-center.ts` — both directions as one list; answer, revise, ask, follow-up.
- `packages/coding-agent/src/cli/questions-control.ts` — `pi control questions`.
- `packages/coding-agent/src/cli/questions-tui.ts` — interactive `pi questions`.
- `packages/coding-agent/src/cli/questions-list.ts` — the `pi questions` list with aligned, width-fitted columns and configurable refresh/new-question shortcuts.
- `packages/coding-agent/src/core/keybindings.ts` — default keybindings for the `pi questions` list.
- `packages/coding-agent/src/supervisor/inspect-session.ts` and `packages/coding-agent/src/supervisor/mail.ts` — bounded remote session-name lookup for question rows. It sends only requested session IDs, accepts names only from the addressed peer and only for requested IDs, returns stored names without transcript, cwd, or goal data, and silently keeps host/ID labels when a peer has no name-lookup support or does not reply. Peers need the name-only relay handler; older peers do not receive a question session name.
- `packages/coding-agent/extensions/supervisor-session/src/ask-command.ts` — `/ask`.

## Tests asserting this spec

- `packages/coding-agent/test/user-questions.test.ts` — storage, answer updates, retention, and relay import.
- `packages/coding-agent/test/suite/user-questions.test.ts` — live session delivery, answer tool execution, and follow-up delivery with earlier context.
- `packages/coding-agent/test/questions-control.test.ts` — `pi control questions`: answer and revise an agent question, show Agent for answered user questions and unknown for historical agent-question answers without a recorded source, answer a cancelled one (reply and correction addressed to the asker's host), ask and follow up (delivery addressed to the target host with earlier context), rejected answers, refusal off the store host.
- `packages/coding-agent/test/questions-tui.test.ts` — `pi questions` list at widths 80 and 140: every line fits the width, header and rows start each column at the same offset, answers and truthful sources show, tab switches between unanswered and all, Ctrl+N and Ctrl+R actions are available without action rows, Quit remains selectable on an empty list, long answers are clipped at the narrow width, j/k and arrows move the selection, Enter opens the aligned detail view, Escape returns and quits; controlled-clock tests cover unanswered-list refresh, selection stability, answered-row removal, all-history manual refresh, panel protection, and timer cleanup.
- `packages/coding-agent/test/questions-session-names.test.ts` — remote name lookup through two host relays, name-only response from stored metadata without a readable transcript, remote-name rendering, and honest fallback when no name is available.
- `packages/coding-agent/test/ask-command-extension.test.ts` — `/ask`: prefix and picker asks stored for the target host, ambiguous prefix and missing question rejected, refusal off the store host.

## Known gaps (current cycle)

- [ ] No direct tests for blank-answer rejection, the answer transcript row, or child-runtime exclusion.
- [ ] The interactive `pi questions` answer panel, follow-up, and ask flows have a manual tmux smoke test only.

## Out of scope

- Question delivery to child-agent runtimes; questions target main sessions only.
