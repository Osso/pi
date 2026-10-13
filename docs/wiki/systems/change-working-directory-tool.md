# Change working directory

Contract: [Change working directory tool](../../specs/change-working-directory-tool.md).

## Target resolution

[`change-working-directory.ts`](../../../packages/coding-agent/src/core/tools/change-working-directory.ts) registers a sequential built-in tool accepting exactly one nonempty `path` or `id`. Paths resolve against current `ctx.cwd` and must exist as directories. IDs use [`resume-session.ts`](../../../packages/coding-agent/src/core/tools/resume-session.ts) to locate a session file; selecting the current file is rejected. No referenced session is resumed or modified.

**Current limitation:** ID lookup reads `readSessionHeader(sessionPath).cwd`, which is the referenced session's immutable initial cwd, not its current control-DB cwd after relocation. Adopting a relocated session's current cwd is therefore not implemented by this path.

## Runtime handoff

Execution requires `ctx.relocateAfterToolResult`. It schedules relocation by tool-call ID and returns `terminate: true` plus previous/new cwd metadata. The relocation-aware session path persists the tool result before replacing the runtime; mixed batches finish before the next model request in the new cwd.

[`agent-session-runtime.ts`](../../../packages/coding-agent/src/core/agent-session-runtime.ts) prepares relocation on the existing SessionManager, appends a visible `cwd_changed` context message, tears down the old runtime, and builds a replacement with `session_start` reason `resume`. Activation releases lifecycle exclusion before calling `continue()`. Session identity and conversation remain unchanged; old extension contexts must not be retained.

[`session-manager.ts`](../../../packages/coding-agent/src/core/session-manager.ts) copies persisted JSONL during relocation and moves control data; it does not rewrite the initial header into current cwd. Current cwd lives in control metadata. [`bwrap/src/index.ts`](../../../packages/coding-agent/extensions/bwrap/src/index.ts) resolves unsandboxed overrides from current context cwd.

## Deleted-cwd recovery

`AgentSessionRuntime` binds recovery hooks to `AgentSession`: before an idle `prompt()` or `continue()`, and after a completed turn before the next model request. Recovery does not cancel an in-flight tool. A missing session cwd uses [`session-cwd.ts`](../../../packages/coding-agent/src/core/session-cwd.ts) to walk upward to the nearest existing **directory**, skipping files. Errors other than `ENOENT`/`ENOTDIR` surface rather than selecting another path.

Before an idle run, recovery activates relocation and forwards the original prompt or continuation to the rebuilt session. Between turns, it prepares the existing relocation handoff; completed tool results remain committed before activation. Both paths reuse `cwd_changed`, persist current cwd, and rebuild resources without changing session ID.

Process cwd is checked separately. Only an invalid process cwd triggers `process.chdir()` to the valid session cwd or selected parent, with a visible `process_cwd_recovered` custom message. When session cwd is already valid, process-only repair does not relocate the session or rebuild its resources. A valid process cwd is left unchanged even when it differs from session cwd.

## Extension and provider boundaries

[`extensions/loader.ts`](../../../packages/coding-agent/src/core/extensions/loader.ts) supplies readonly `ExtensionAPI.cwd` from the extension instance's loader cwd, available during factory activation. Use handler `ctx.cwd` for current session work; runtime relocation creates a new extension instance rather than updating captured old objects.

[`sdk.ts`](../../../packages/coding-agent/src/core/sdk.ts) supplies the calling session cwd on each provider stream invocation through [`StreamOptions.cwd`](../../../packages/ai/src/types.ts). Shared local/subprocess providers must select cwd per call, not retain one registering extension's cwd or infer it from process cwd. This option is integration metadata, not a remote request payload field.

## Evidence

Tests inspected, not run: [tool suite](../../../packages/coding-agent/test/suite/change-working-directory-tool.test.ts) (targets, identity, relative paths), [mixed batch](../../../packages/coding-agent/test/suite/change-working-directory-mixed-batch.test.ts) (live child, mailbox and relative reads), [runtime suite](../../../packages/coding-agent/test/suite/agent-session-runtime.test.ts) (replacement/restart), and [file operations](../../../packages/coding-agent/test/session-manager/file-operations.test.ts) (persisted relocation).
