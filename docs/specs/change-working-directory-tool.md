# Change Working Directory Tool

Module boundary: core built-in tool and session runtime.

The `change_working_directory` tool changes the current Pi session's working directory without switching session identity. It accepts a direct directory path or another Pi session ID whose recorded cwd should be adopted. Runtime lifecycle details remain in [`session-lifecycle-hooks.md`](session-lifecycle-hooks.md).

## What it must do

### Tool surface

- [x] `change_working_directory` is registered as a built-in tool and active by default.
- [x] The tool accepts exactly one target: `path` or `id`.
- [x] Direct paths resolve relative to the current session cwd.
- [x] Session IDs resolve to the referenced session file's recorded cwd.
- [x] ID-based changes do not resume, replace, or modify the referenced session; the current session ID is rejected as a target.
- [x] Empty, missing, multiple, nonexistent, and non-directory targets fail explicitly.

### Runtime behavior

- [x] Changing cwd preserves the current session ID and conversation.
- [x] The current session header and control metadata persist the changed cwd.
- [x] Cwd-bound services, resources, extension contexts, and built-in tools are rebuilt for the changed directory.
- [x] The terminal tool result is emitted and persisted before the directory change takes effect.
- [x] Changing cwd during an active agent turn continues that turn without requiring another user prompt.
- [x] The intermediate `agent_end` boundary is marked as a cwd-relocation continuation so idle extensions defer until the continued turn settles.
- [x] Subsequent relative tool paths resolve from the changed cwd.
- [x] A real process restart restores the changed cwd and relative tool behavior from the persisted session.
- [x] Unsandboxed bwrap tool overrides resolve each execution from current extension-context cwd instead of process startup cwd.

## How it works

- [`session-lifecycle-hooks.md`](session-lifecycle-hooks.md) defines runtime shutdown/start behavior.
- [`resume-session-tool.md`](resume-session-tool.md) defines the separate session replacement tool and shared session-ID resolution semantics.
- [`bwrap-sandbox.md`](bwrap-sandbox.md) defines first-party file-tool routing.

## Implementation inventory

- `packages/coding-agent/src/core/tools/change-working-directory.ts` — validates path/ID targets and invokes runtime relocation.
- `packages/coding-agent/src/core/tools/resume-session.ts` — provides shared session-ID-to-file resolution.
- `packages/coding-agent/src/core/tools/index.ts` — registers the tool in built-in inventories and factories.
- `packages/coding-agent/src/core/agent-session-runtime.ts` — relocates the persisted session and rebuilds cwd-bound runtime state.
- `packages/coding-agent/src/core/extensions/types.ts` — exposes optional runtime relocation on extension contexts.
- `packages/coding-agent/src/core/extensions/runner.ts` — forwards extension-context relocation to the active runtime.
- `packages/coding-agent/extensions/bwrap/src/index.ts` — rebuilds unsandboxed file-tool definitions from current cwd per execution.

## Tests asserting this spec

- `packages/coding-agent/test/suite/change-working-directory-tool.test.ts`
- `packages/coding-agent/test/suite/agent-session-runtime.test.ts`
- `packages/coding-agent/test/session-manager/file-operations.test.ts`

## Known gaps (current cycle)

No current-cycle gaps.

## Out of scope

- Switching or resuming the referenced session.
- Modifying the referenced session's cwd or transcript.
- Inferring cwd from goal text, prompts, repository names, or process activity when the referenced session records a different cwd.
