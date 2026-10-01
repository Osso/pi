# Tool backgrounding

Contract: [Tool backgrounding](../../specs/tool-backgrounding.md).

## Detaching work

[`ToolDetachRegistry`](../../../packages/coding-agent/src/core/tool-detach-registry.ts) stores opt-in handles and starts a 600,000 ms timer per registration. Manual `detachRunning()` tries newest handles first until one succeeds; automatic expiry calls that handle's `detach()`. Unregistering clears the timer. The timer releases foreground waiting; it does not replace a tool's execution timeout.

[`AgentSession`](../../../packages/coding-agent/src/core/agent-session.ts) supplies the registry to tools/extensions. [`InteractiveMode`](../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) binds configurable `app.tool.background` (default Ctrl+B) to session detachment. Unsupported tools remain foreground.

[`bash.ts`](../../../packages/coding-agent/src/core/tools/bash.ts) uses the durable runner when session lifecycle support is available. Detachment activates the background job synchronously and removes the foreground abort listener; later turn cancellation/restart teardown does not kill detached work. The foreground result identifies the job and output artifact. Later bytes remain in its log; timeout and `close_agent` still terminate work.

[`Pyrun detached-evaluation.ts`](../../../packages/coding-agent/extensions/pyrun/src/detached-evaluation.ts) requires a persisted supervisor, prepared execution agent ID, and lifecycle start timestamp. It writes `launch.json`, permission-locked `script.py`, and `output.log`, then observes canonical JSONL progress/results. The application-owned agent ID is separate from the provider tool-call ID. Detachment returns the job ID/log path while the runner continues. Results retain `durationMs`; notifications include duration. The interactive agent view renders script/output artifacts, not a fabricated child transcript.

## Recovery and completion

Bash replay waits for the matching persisted active job or reuses its terminal result; `failed/lost_runtime` permits replacement execution. Pyrun replay opens only the prepared agent's manifest, validates identity/parameters/correlation, replays complete terminal records, or reconnects to a live runner. A dead Pyrun runner without a terminal record reports `lost_runtime` and never reruns submitted code. Complete malformed JSONL fails; an incomplete final line is ignored.

[`agents-core/runtime.ts`](../../../packages/coding-agent/extensions/agents-core/src/runtime.ts) implements `wait_agent`: pending terminal notifications take precedence; persisted coordination is consumed through mailbox delivery and shared-channel cursor advancement. [`detached-runtime-cancellation.ts`](../../../packages/coding-agent/extensions/agents-core/src/detached-runtime-cancellation.ts) requests silent cancellation of active directly owned detached runtime jobs during subagent terminal cleanup. Normal main-session jobs and explicit close operations retain notifications.

[`detached-job-cleanup.ts`](../../../packages/coding-agent/src/core/detached-job-cleanup.ts) and [`retention.ts`](../../../packages/coding-agent/src/core/detached-job-retention.ts) remove unprotected terminal artifacts aged three days, then oldest artifacts toward a 2 GiB cap. Linux `/proc` reference checks protect live users; cleanup skips deletion without that inspection. Startup and terminal delivery invoke cleanup. Copy needed logs before retention removes them.

## Limits and test locations

Only registered detachable tools qualify; durable job support depends on persisted lifecycle infrastructure. The contract's real-TUI Ctrl+B smoke test remains missing.

- [`bash-tool-detach.test.ts`](../../../packages/coding-agent/test/bash-tool-detach.test.ts): manual/automatic detach, later log output, timeout, replay, and cancellation.
- [`pyrun-extension.test.ts`](../../../packages/coding-agent/test/pyrun-extension.test.ts), [`detached-pyrun-runner.test.ts`](../../../packages/coding-agent/test/detached-pyrun-runner.test.ts): artifacts, duration, runner failures, and process-tree cancellation.
- [`suite/headless-pi.test.ts`](../../../packages/coding-agent/test/suite/headless-pi.test.ts): live-runner restoration and foreground Bash/Pyrun survival across `/restart`.
- [`interactive-mode-status.test.ts`](../../../packages/coding-agent/test/interactive-mode-status.test.ts), [`runtime-mailbox.test.ts`](../../../packages/coding-agent/test/runtime-mailbox.test.ts): artifact presentation and completion delivery.
- [`detached-job-cleanup.test.ts`](../../../packages/coding-agent/test/detached-job-cleanup.test.ts), [`detached-job-retention.test.ts`](../../../packages/coding-agent/test/detached-job-retention.test.ts): protected artifacts, age, and size selection.

Tests were inspected, not executed. See [multi-agent implementation](multi-agent.md) for lifecycle ownership and transport.
