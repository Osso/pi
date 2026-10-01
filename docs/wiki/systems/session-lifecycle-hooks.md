# Session lifecycle hooks

Contract: [Session lifecycle hooks](../../specs/session-lifecycle-hooks.md). Author API: [extensions](../../../packages/coding-agent/docs/extensions.md#session-events), [SDK runtime](../../../packages/coding-agent/docs/sdk.md), and [compaction](../../../packages/coding-agent/docs/compaction.md).

## Ownership and ordering

[extensions/types.ts](../../../packages/coding-agent/src/core/extensions/types.ts) declares event/result shapes and `pi.on` overloads. [ExtensionRunner](../../../packages/coding-agent/src/core/extensions/runner.ts) awaits handlers in extension/registration order. For session-before events, cancellation short-circuits; otherwise the last nonempty result is returned, not a merged object. Handler exceptions are reported through the extension error path rather than treated as cancellation.

[AgentSessionRuntime](../../../packages/coding-agent/src/core/agent-session-runtime.ts) serializes new/resume/fork, reload, relocation, restart, import, and disposal through a transition queue. New/resume emits `session_before_switch`; fork/clone emits `session_before_fork` with `entryId` and position `before`/`at`. Cancellation retains the current runtime. Successful replacement emits old-runtime `session_shutdown`, performs host cleanup, removes eligible abandoned empty sessions, disposes the old session, creates the replacement, then rebinds it. The replacement's `session_start` is emitted by [AgentSession.bindExtensions](../../../packages/coding-agent/src/core/agent-session.ts), followed by resource discovery.

Start reasons are `startup`, `reload`, `new`, `resume`, `fork`, and `restart`; shutdown also has `quit`. Replacement events carry previous/target files where available. Cwd relocation uses `resume` while retaining identity; reload rebuilds resources without switching the transcript. Captured old `pi`/context objects become stale. `withSession` runs after rebind against the replacement context, but remains in the old closure: capture plain data, not old session resources.

## In-session hooks

[AgentSession](../../../packages/coding-agent/src/core/agent-session.ts) owns compaction and tree hooks. `session_before_compact` can cancel or supply a compaction result; `session_compact` follows persistence. `session_before_tree` receives preparation and an abort signal; its returned instructions/label affect navigation, while a returned summary is used only when summarization was requested. Navigation updates the leaf/context before `session_tree`; cancellation clears branch-summary state in `finally`.

`resources_discover` runs after startup/reload. `emitResourcesDiscover` aggregates skill/prompt/theme paths with supplying-extension provenance; AgentSession extends resources and rebuilds its prompt. `project_trust` runs before project-local resources load; first decisive yes/no result wins.

`requestResumeContinuation()` sets one coalesced flag. [InteractiveMode](../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) and [RPC mode](../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts) consume/clear it before continuation. [Print mode](../../../packages/coding-agent/src/modes/print-mode.ts) routes lifecycle actions through the same runtime owner.

## Implementation and coverage gaps

`skipConversationRestore` exists in the fork result type but **has no implemented effect**: runtime fork handling reads only `cancel`. Fork cancellation and fork start/shutdown reasons are already covered by [agent-session-runtime-events.test.ts](../../../packages/coding-agent/test/agent-session-runtime-events.test.ts), contrary to the spec's gap note.

Other inspected test locations (not executed): [2860 replacement-context regression](../../../packages/coding-agent/test/suite/regressions/2860-replaced-session-context.test.ts), [cwd relocation/restart tests](../../../packages/coding-agent/test/suite/change-working-directory-tool.test.ts), [compaction-extensions.test.ts](../../../packages/coding-agent/test/compaction-extensions.test.ts), [3688 tree-cancel regression](../../../packages/coding-agent/test/suite/regressions/3688-tree-cancel-compacting.test.ts), [extensions-runner.test.ts](../../../packages/coding-agent/test/extensions-runner.test.ts), and [resume-continuation-request.test.ts](../../../packages/coding-agent/test/suite/resume-continuation-request.test.ts). The continuation tests inspect flag behavior in the session harness, not a process-level TUI/RPC continuation.

The spec-listed coverage does not demonstrate tree summary-field customization, the tree after-event, or resource-path aggregation. Those paths are implemented; missing dedicated proof is not missing implementation.
