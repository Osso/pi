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

- [x] `pi questions` is an interactive terminal view, usable over SSH and as a remote-agent managed session (`pi_args: ["questions"]`). It lists unanswered questions (waiting for the user, the Supervisor, or the asked agent) newest first; `app.questions.toggleAll` (default tab) switches to all questions of the last three days and back. It shows each answered agent question with its chosen answers and their source (and revision time) in the list and a detail view before an explicit "Revise the answer", offers an answer for a question cancelled without one, answers or revises an agent question in the `ask_questions` panel, shows an agent's full answer to a user question with an "Ask a follow-up" action, and asks a new question of a running local session, a remote session seen in stored questions, or a typed `host:session-id`.
- [x] `pi control questions list [--json]`, `answer <a-ref> <answer>` / `answer <a-ref> --json <answers>`, `ask <session-id> [--host <host>] <question>`, and `follow-up <u-ref> <question>` give the same operations without a terminal UI, for scripts and a future mobile service. Errors exit with status 1 and a message.
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
- `packages/coding-agent/extensions/supervisor-session/src/ask-command.ts` — `/ask`.

## Tests asserting this spec

- `packages/coding-agent/test/user-questions.test.ts` — storage, answer updates, retention, and relay import.
- `packages/coding-agent/test/suite/user-questions.test.ts` — live session delivery, answer tool execution, and follow-up delivery with earlier context.
- `packages/coding-agent/test/questions-control.test.ts` — `pi control questions`: answer and revise an agent question, answer a cancelled one (reply and correction addressed to the asker's host), ask and follow up (delivery addressed to the target host with earlier context), rejected answers, refusal off the store host.
- `packages/coding-agent/test/ask-command-extension.test.ts` — `/ask`: prefix and picker asks stored for the target host, ambiguous prefix and missing question rejected, refusal off the store host.

## Known gaps (current cycle)

- [ ] No direct tests for blank-answer rejection, the answer transcript row, or child-runtime exclusion.
- [ ] The interactive `pi questions` view has a manual tmux smoke test only.

## Out of scope

- Question delivery to child-agent runtimes; questions target main sessions only.
