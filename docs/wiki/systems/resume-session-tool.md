# Resume-session tool

[Contract](../../specs/resume-session-tool.md). `resume_session` replaces the current main supervisor context; [attachment](resume-session-as-agent.md) is a different operation.

## Resolution and replacement

[resume-session.ts](../../../packages/coding-agent/src/core/tools/resume-session.ts) defines a sequential built-in tool, registered by [tools/index.ts](../../../packages/coding-agent/src/core/tools/index.ts). Parameters require exactly one nonempty `path`, `id`, or `name`, plus optional `starter_prompt`. Paths resolve relative to cwd and must name a regular `.jsonl` or archived `.jsonl.zst` file. IDs prefer an exact match before a unique prefix; names require a unique exact match. Current-directory metadata is preferred, then broader metadata. When no metadata match exists, source also contains session-listing resolution paths.

The tool rejects the current session and explicit child-agent contexts, and requires `ctx.switchSession`. It passes starter instructions as plain captured text to a `withSession` callback; that callback uses only the fresh replacement context's `sendUserMessage`.

[AgentSessionRuntime.switchSessionUnlocked](../../../packages/coding-agent/src/core/agent-session-runtime.ts) first emits `session_before_switch`. Cancellation leaves the caller active and skips starter delivery. Otherwise it restores an explicitly addressed archive, opens the target, checks cwd and main-runtime ownership, and only then tears down the caller. Another live owner therefore prevents replacement before caller shutdown. Replacement emits the old session's shutdown and new session's resume start, rebinds runtime services, then runs `withSession`.

The tool returns `{ cancelled, resumed, sessionPath }` and `terminate: true`. For archived input, reported `sessionPath` is the requested archive path, while the active runtime uses the restored JSONL path.

## Continuation and boundaries

[AgentSession](../../../packages/coding-agent/src/core/agent-session.ts) stores a one-shot resume-continuation request and classifies interrupted transcript state. [Interactive mode](../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) and [RPC mode](../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts) consume the request before continuing. A completed `end_turn` stays idle absent an extension request; a pending assistant batch containing `resume_session` is treated as a terminal switch rather than replayed into the source transcript.

Old extension contexts become stale after replacement; the tool's callback deliberately avoids them. Direct SDK sessions without switching support cannot use this tool. ID/name metadata lookup excludes inactive/subagent entries, but explicit paths and the source's listing paths are separate resolution mechanisms. No new-session creation or transcript merge is implemented by this tool.

## Test evidence

Tests inspected, not run: [7421 regression](../../../packages/coding-agent/test/suite/regressions/7421-resume-session-tool.test.ts) covers selectors, ownership rejection, source reopening, default availability, starter delivery, archive restoration, and cancellation. [Continuation-request tests](../../../packages/coding-agent/test/suite/resume-continuation-request.test.ts) assert consume-once behavior. [Process-restart tests](../../../packages/coding-agent/test/suite/regressions/restart-self-auto-continuation.test.ts) locate completed-turn and running-goal continuation cases. No unimplemented tool behavior identified in the inspected replacement path.
