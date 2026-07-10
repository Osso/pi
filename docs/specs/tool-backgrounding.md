# Tool Backgrounding

Module boundary: core subsystem plus first-party tool integrations.

Tool backgrounding lets sessions detach supported in-flight tool calls from the current turn and track their completion as background jobs.

## What it must do

- [x] `Ctrl+B` detaches a supported running tool through the shared tool detach registry.
- [x] Supported running tools auto-detach through the same shared registry after 120 seconds.
- [x] Auto-detach moves the tool out of the foreground only; explicit tool timeout settings continue to kill/fail the underlying work.
- [x] Detached bash commands create a background job, write later output to a log artifact, and support cancellation through `cancel_agent`.
- [x] Detached Pyrun evaluations create a background job, complete independently, and write final output to a log artifact.
- [x] `wait_agents({})` waits until any detached tool job active at invocation reaches a terminal state.
- [x] Tool-specific detach support must be opt-in; tools without a registered detach handle are not detached.

## How it works

- See [multi-agent](multi-agent.md) for background job storage and lifecycle tracking.
- The shared detach registry owns the auto-detach timer so the behavior is available to API and interactive execution paths whenever the session exposes a registry.
- `wait_agents({})` snapshots active background jobs, immediately consumes one pending completion notification when available, or waits for the first terminal job. The direct tool returns that winner's completion or status; the Hostrun/Pyrun bridge returns `null`.

## Implementation inventory

- `packages/coding-agent/src/core/tool-detach-registry.ts` — shared in-flight tool detach registry.
- `packages/coding-agent/src/core/agent-session.ts` — owns the session detach registry and exposes it to base tools and extensions.
- `packages/coding-agent/src/core/tools/bash.ts` — registers bash commands as detachable and tracks detached subprocesses.
- `packages/coding-agent/extensions/pyrun/src/index.ts` — registers Pyrun evaluations as detachable and tracks detached evaluations. Pyrun command guidance treats `run.*` as exit-code-only and `cli.*` as the captured `CommandResult` API.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — binds the background action to the active session registry.

## Tests asserting this spec

- `packages/coding-agent/test/bash-tool-detach.test.ts`
- `packages/coding-agent/test/pyrun-extension.test.ts`
- `packages/coding-agent/test/multi-agent-extension.test.ts`

## Known gaps (current cycle)

- [ ] Add an interactive smoke test that verifies the `Ctrl+B` key path in a real TUI session.

## Out of scope

- Detaching arbitrary extension tools without explicit detach support.
- Cancelling detached Pyrun evaluations; Pyrun runs through a shared persistent runner without safe per-request cancellation.
