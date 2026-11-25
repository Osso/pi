# User questions

Module boundary: core subsystem.

User questions let a person send a durable question to a running main Pi session. Source lives in `packages/coding-agent/src/user-questions/` and `packages/coding-agent/src/core/tools/`; see the [user questions implementation notes](../wiki/systems/user-questions.md).

## What it must do

### Central storage

- [x] Store question ID, parent ID, target host/session, question, status, answer, creation time, and answer time in the host control database.
- [x] List questions newest first and read one question by ID.
- [x] Accept answer revisions and update the answer time; report an unknown ID to the caller.
- [x] Remove question rows after three days, regardless of status.
- [ ] Store remote-session questions on the configured Supervisor host. An unset or local Supervisor host uses the local store.

### Asking and answering

- [x] `askUserQuestion` delivers a user question to a running main session through its runtime mailbox and wakes an idle session.
- [ ] The target answers with `answer_user_question { id, answer }`. Reject blank answers and record the answer centrally.
- [x] For remote stores, relay the answer to the Supervisor host and record it there without requiring the Supervisor session to run.
- [x] Allow follow-up questions. A follow-up targets the original question's session and includes the earlier question and answer in the delivered message.
- [ ] Render a compact transcript row that includes the answer.
- [ ] Exclude `answer_user_question` from child-agent runtimes.
- [ ] The separately built `pi questions` CLI lists questions, asks questions, and asks follow-ups.

## How it works

- See [`docs/wiki/systems/user-questions.md`](../wiki/systems/user-questions.md) for implementation notes.

## Implementation inventory

- `packages/coding-agent/src/core/session-control-db/user-questions.ts` — stored question operations.
- `packages/coding-agent/src/user-questions/ask.ts` — question insertion and mailbox delivery.
- `packages/coding-agent/src/core/tools/answer-user-question.ts` — answer tool.
- `packages/coding-agent/src/core/host-relay-store.ts` — remote answer import.
- `packages/coding-agent/src/core/session-control-db/connection.ts` — three-day retention.

## Tests asserting this spec

- `packages/coding-agent/test/user-questions.test.ts` — storage, answer updates, retention, and relay import.
- `packages/coding-agent/test/suite/user-questions.test.ts` — live session delivery, answer tool execution, and follow-up delivery with earlier context.

## Known gaps (current cycle)

- [ ] Test remote question delivery to the configured Supervisor host and remote answer submission through the tool.
- [ ] Add direct tests for blank-answer rejection, the answer transcript row, and child-runtime exclusion.
- [ ] Verify `pi questions` CLI behavior in its separately built repository.

## Out of scope

- Question delivery to child-agent runtimes; questions target main sessions only.
