# Self restart

Contract: [Self restart](../../specs/self-restart.md).

## Request and teardown

The [self-restart extension](../../../packages/coding-agent/extensions/self-restart/src/index.ts) registers `/restart` and approval-required `restart_self`; both request `ctx.restart({ notice, process: true })`. [AgentSession._restartFromExtension](../../../packages/coding-agent/src/core/agent-session.ts) rejects live child runtimes before handoff. Historical subagent transcript metadata is not that authorization check.

[AgentSessionRuntime.restart](../../../packages/coding-agent/src/core/agent-session-runtime.ts) serializes the transition and detaches running detachable tools. With `process: true` and a persisted session file, it persists recovery state, invokes the host's pre-restart cleanup, emits `session_shutdown` with reason `restart`, disposes the runtime, and calls the process restarter. [InteractiveMode](../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) supplies terminal cleanup and routes `SIGHUP` through this same path.

## Process handoff and startup

[core/self-restart.ts](../../../packages/coding-agent/src/core/self-restart.ts) re-execs `process.execPath` with the existing argv/execArgv, stripping Bun virtual entrypoints. `execve` preserves PID and terminal job-control ownership. Where unavailable, a direct child spawn inherits stdio and the parent exits. There is no wrapper request-file or restart-exit-code path.

The handoff carries session file, notice, and old PID in `PI_SELF_RESTART_*` environment variables. Startup consumes and deletes them; an old PID belonging to neither the current process nor its parent invalidates the request. `applySelfRestartRequest` selects the saved session and clears original prompts/file arguments.

[main.ts](../../../packages/coding-agent/src/main.ts) reopens the session, handles a deleted cwd by reopening at the existing parent selected by cwd recovery, resolves unfinished trailing tool calls, then appends the typed `self_restart` custom message. Missing results become restart success, detached-job references, or interrupted errors; existing results are not duplicated. The notice is not a user prompt or title/search input. TUI and [RPC startup](../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts) continue interrupted context through `session.continue()`.

## Limits and evidence

In-process replacement is selected when process restart is not requested or persistence is unavailable; it rebuilds the same session and emits restart lifecycle events. **The spec's Print/RPC in-process-only gap note does not match current source:** [print-mode.ts](../../../packages/coding-agent/src/modes/print-mode.ts) and [rpc-mode.ts](../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts) forward restart options unchanged, so a persisted `process: true` request reaches the process restarter there too.

Test source inspected, not executed:

- [self-restart.test.ts](../../../packages/coding-agent/test/self-restart.test.ts), [self-restart-extension.test.ts](../../../packages/coding-agent/test/self-restart-extension.test.ts): environment/argv handling, notice classification, missing results, and registration.
- [2860-replaced-session-context.test.ts](../../../packages/coding-agent/test/suite/regressions/2860-replaced-session-context.test.ts), [agent-session-model-extension.test.ts](../../../packages/coding-agent/test/suite/agent-session-model-extension.test.ts): same-file lifecycle and context binding.
- [restart-self-auto-continuation.test.ts](../../../packages/coding-agent/test/suite/regressions/restart-self-auto-continuation.test.ts), [missing-session-cwd-restart.test.ts](../../../packages/coding-agent/test/suite/regressions/missing-session-cwd-restart.test.ts): real-process continuation and child rejection.
- [headless-pi.test.ts](../../../packages/coding-agent/test/suite/headless-pi.test.ts): foreground Bash/Pyrun work surviving restart as detached jobs.
- [interactive-mode-startup-input.test.ts](../../../packages/coding-agent/test/interactive-mode-startup-input.test.ts), [sighup-restart-harness.test.ts](../../../packages/coding-agent/test/suite/regressions/sighup-restart-harness.test.ts): direct-command display and signal routing; the latter mocks routing, not a terminal exec.
