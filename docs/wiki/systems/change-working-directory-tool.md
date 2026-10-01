# Change working directory

Contract: [Change working directory tool](../../specs/change-working-directory-tool.md).

## Target resolution

[`change-working-directory.ts`](../../../packages/coding-agent/src/core/tools/change-working-directory.ts) registers a sequential built-in tool accepting exactly one nonempty `path` or `id`. Paths resolve against current `ctx.cwd` and must exist as directories. IDs use [`resume-session.ts`](../../../packages/coding-agent/src/core/tools/resume-session.ts) to locate a session file; selecting the current file is rejected. No referenced session is resumed or modified.

**Current limitation:** ID lookup reads `readSessionHeader(sessionPath).cwd`, which is the referenced session's immutable initial cwd, not its current control-DB cwd after relocation. Adopting a relocated session's current cwd is therefore not implemented by this path.

## Runtime handoff

Execution requires `ctx.relocateAfterToolResult`. It schedules relocation by tool-call ID and returns `terminate: true` plus previous/new cwd metadata. The relocation-aware session path persists the tool result before replacing the runtime; mixed batches finish before the next model request in the new cwd.

[`agent-session-runtime.ts`](../../../packages/coding-agent/src/core/agent-session-runtime.ts) prepares relocation on the existing SessionManager, appends a visible `cwd_changed` context message, tears down the old runtime, and builds a replacement with `session_start` reason `resume`. Activation releases lifecycle exclusion before calling `continue()`. Session identity and conversation remain unchanged; old extension contexts must not be retained.

[`session-manager.ts`](../../../packages/coding-agent/src/core/session-manager.ts) copies persisted JSONL during relocation and moves control data; it does not rewrite the initial header into current cwd. Current cwd lives in control metadata. [`bwrap/src/index.ts`](../../../packages/coding-agent/extensions/bwrap/src/index.ts) resolves unsandboxed overrides from current context cwd.

## Evidence

Tests inspected, not run: [tool suite](../../../packages/coding-agent/test/suite/change-working-directory-tool.test.ts) (targets, identity, relative paths), [mixed batch](../../../packages/coding-agent/test/suite/change-working-directory-mixed-batch.test.ts) (live child, mailbox and relative reads), [runtime suite](../../../packages/coding-agent/test/suite/agent-session-runtime.test.ts) (replacement/restart), and [file operations](../../../packages/coding-agent/test/session-manager/file-operations.test.ts) (persisted relocation).
