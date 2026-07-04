# Resume Session Tool

Module boundary: core built-in tool.

The `resume_session` tool lets an agent switch the current main Pi session to an existing saved session without using Pyrun. It is intentionally explicit because it replaces the current supervisor context. Implementation details should live in [`docs/wiki/systems/resume-session-tool.md`](../wiki/systems/resume-session-tool.md) once needed.

## What it must do

### Tool surface

- [x] `resume_session` is registered as a built-in tool and active by default.
- [x] The tool accepts exactly one session target: `path`, `id`, or `name`.
- [x] The tool rejects empty or ambiguous targets.
- [x] The tool description warns that it replaces the current supervisor context.

### Session replacement

- [x] Resuming by path switches the current main session to the target session file.
- [x] Session replacement uses the existing `switchSession` lifecycle so `session_before_switch`, `session_shutdown`, and `session_start` behavior is preserved.
- [x] If a `session_before_switch` hook cancels the resume, the tool reports `cancelled: true` and leaves the current session unchanged.
- [x] The tool is unavailable when the current extension context cannot switch sessions.
- [x] The tool is rejected from child-agent contexts because replacing the main supervisor context from a child would break ownership semantics.

### Starter prompt

- [x] The optional `starter_prompt` is sent only after the target session is active.
- [x] The starter prompt uses the replacement session context, not the stale pre-resume context.
- [x] If resume is cancelled, the starter prompt is not sent.

## How it works

- [`docs/specs/session-lifecycle-hooks.md`](session-lifecycle-hooks.md) defines the session resume/switch lifecycle behavior reused by this tool.
- [`docs/specs/resume-session-as-agent.md`](resume-session-as-agent.md) covers the separate child-agent attachment path; this tool is for replacing the main session context.

## Implementation inventory

- `packages/coding-agent/src/core/tools/resume-session.ts` — defines `resume_session`, target resolution, rendering, and starter prompt delivery.
- `packages/coding-agent/src/core/tools/index.ts` — registers `resume_session` in built-in tool lists and factories.
- `packages/coding-agent/src/core/extensions/types.ts` — exposes `switchSession(..., { withSession })` on extension contexts.
- `packages/coding-agent/src/core/extensions/runner.ts` — forwards `switchSession` options from extension contexts to the runtime handler.

## Tests asserting this spec

- `packages/coding-agent/test/suite/regressions/7421-resume-session-tool.test.ts`

## Known gaps (current cycle)

- [x] Add a first built-in `resume_session` tool for main-thread session replacement.
- [x] Add starter prompt delivery through the replacement-session context.
- [x] Add cancellation and child-agent safety regressions.

## Out of scope

- Resuming a session as a child agent; see [`resume-session-as-agent.md`](resume-session-as-agent.md).
- Creating a new session or forking a session.
- Allowing child agents to replace the supervisor's main session.
