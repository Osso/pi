# Tool Backgrounding

Module boundary: core subsystem plus first-party tool integrations.

Tool backgrounding lets sessions detach supported in-flight tool calls from the current turn and track their completion as background jobs.

## What it must do

- [x] `Ctrl+B` detaches a supported running tool through the shared tool detach registry.
- [x] Supported running tools auto-detach through the same shared registry after 120 seconds.
- [x] Auto-detach moves the tool out of the foreground only; explicit tool timeout settings continue to kill/fail the underlying work.
- [x] Detached bash commands create a background job, write later output to an absolute log file reference, and support cancellation through `cancel_agent`.
- [x] Detached Pyrun evaluations create a background job, complete independently, expose final output through an absolute log file reference, persist the submitted source as a permission-locked `script.py` file reference for the full running and terminal lifecycle, and record elapsed time in the agent result's `durationMs` field.
- [x] The live-agent TUI view renders the detached Pyrun script and output log without fabricating a child transcript.
- [x] Detached Pyrun completion and failure notifications include the recorded duration as `Duration: Nms`.
- [x] `wait_agents({})` consumes one pending completion notification before querying detached tool jobs
      active at invocation for a terminal agent row. Notifications only wake the query; the agent row is
      terminal truth. It does not consume shared mailbox delivery; failed jobs expose their failure message
      and direct `fileRefs`.
- [x] Tool-specific detach support must be opt-in; tools without a registered detach handle are not detached.
- [x] Only jobs explicitly detached from their waiting tool call emit a terminal supervisor mailbox
      notification, recorded through a fenced `detached` lifecycle mark. Attended runner-owned jobs
      deliver results in-band through the waiting tool call without a mailbox wakeup; terminal outbox
      rows and lifecycle events remain unconditional.

## How it works

- See [multi-agent](multi-agent.md) for background job storage and lifecycle tracking.
- The shared detach registry owns the auto-detach timer so the behavior is available to API and interactive execution paths whenever the session exposes a registry.
- `wait_agents({})` snapshots active background jobs, consumes one pending completion notification, and
  queries current agent rows until the first snapshot member is terminal. Notifications only wake the
  query, so simultaneous and late waiters read current agent-row truth without changing runtime-mailbox
  delivery state. Hostrun/Pyrun uses the same wait operation.

## Implementation inventory

- `packages/coding-agent/src/core/tool-detach-registry.ts` — shared in-flight tool detach registry.
- `packages/coding-agent/src/core/agent-session.ts` — owns the session detach registry and exposes it to base tools and extensions.
- `packages/coding-agent/src/core/tools/bash.ts` — registers bash commands as detachable and tracks detached subprocesses.
- `packages/coding-agent/extensions/pyrun/src/index.ts` and `detached-evaluation.ts` — register Pyrun evaluations as detachable, persist submitted source, and track detached evaluations. Pyrun command guidance treats both `run.*` and default `cli.*.run()` as forwarding, exit-code-only execution; `.capture().run()` explicitly returns a `CommandResult`.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — binds the background action to the active session registry and renders live script/output artifacts.

## Tests asserting this spec

- `packages/coding-agent/test/bash-tool-detach.test.ts`
- `packages/coding-agent/test/pyrun-extension.test.ts` — detached Pyrun script/output persistence, completion/failure regressions, elapsed `durationMs`, and duration-bearing lifecycle notifications.
- `packages/coding-agent/test/interactive-mode-status.test.ts` — live detached Pyrun script/output rendering without a transcript.
- `packages/coding-agent/test/runtime-mailbox.test.ts` — explicit runtime mailbox delivery plus
  completion-notification wakeups and simultaneous/late waiter queries.
- `packages/coding-agent/test/multi-agent-extension.test.ts`

## Known gaps (current cycle)

- [ ] Add an interactive smoke test that verifies the `Ctrl+B` key path in a real TUI session.

## Out of scope

- Detaching arbitrary extension tools without explicit detach support.
