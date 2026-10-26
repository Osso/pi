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
- [x] Control metadata persists the current cwd, while the JSONL header remains the immutable initial cwd; `cwd_changed` entries preserve historical transitions for rewind and branch context.
- [x] Cwd-bound services, resources, extension contexts, and built-in tools are rebuilt for the changed directory.
- [x] The terminal tool result is emitted and persisted before the directory change takes effect.
- [x] Changing cwd during an active agent turn continues that turn without requiring another user prompt.
- [x] When the relocation tool shares a batch with nonterminating tools, Pi completes the batch, ends the old agent loop, and activates the relocated runtime before another model request.
- [x] The session transcript and its control data move only at activation, after every tool in the batch has committed. A child spawned in the same batch as the relocation stays listed and recoverable under the relocated session (`change-working-directory-spawn-batch.test.ts`).
- [x] The intermediate `agent_end` boundary is marked as a cwd-relocation continuation so idle extensions defer until the continued turn settles.
- [x] Subsequent relative tool paths resolve from the changed cwd.
- [x] A real process restart restores the changed cwd and relative tool behavior from the current `session_metadata.cwd` value in control SQLite; the JSONL transcript remains the persisted history of the session's cwd-related entries and is not rewritten or trimmed during relocation.
- [x] Unsandboxed bwrap tool overrides resolve each execution from current extension-context cwd instead of process startup cwd.

### Automatic deleted-cwd recovery

- [ ] Runtime-hosted sessions check cwd before idle `prompt()`/`continue()` dispatch and between completed turns, without cancelling in-flight tools.
- [ ] A missing or non-directory session cwd relocates to its nearest existing directory parent, preserving session ID and conversation, persisting current cwd, emitting the existing visible `cwd_changed` notice, and rebuilding cwd-bound tools and resources.
- [ ] If only process cwd is invalid, Pi changes process cwd to the valid session cwd and emits visible `process_cwd_recovered`; session cwd and runtime resources remain unchanged.
- [ ] Recovery changes process cwd only when it is invalid; a valid process cwd need not match session cwd.
- [ ] Parent selection skips existing non-directory paths; filesystem errors other than missing/non-directory errors fail explicitly.

### Extension and provider cwd

- [ ] Public readonly `ExtensionAPI.cwd` exposes the loader cwd bound to that extension instance, including during factory activation; it is not a process-cwd lookup or a live cross-session value.
- [ ] `StreamOptions.cwd?: string` carries each calling session's cwd to shared local/subprocess provider streams. Providers use the per-call value for session-scoped subprocesses, not captured factory cwd or `process.cwd()`; cwd is not a server payload field.

## How it works

- [Cwd relocation and recovery](../wiki/systems/change-working-directory-tool.md) describes runtime handoff and safe recovery boundaries.
- [`session-lifecycle-hooks.md`](session-lifecycle-hooks.md) defines runtime shutdown/start behavior.
- [`resume-session-tool.md`](resume-session-tool.md) defines the separate session replacement tool and shared session-ID resolution semantics.
- [`bwrap-sandbox.md`](bwrap-sandbox.md) defines first-party file-tool routing.

## Implementation inventory

- `packages/coding-agent/src/core/tools/change-working-directory.ts` — validates path/ID targets and invokes runtime relocation.
- `packages/coding-agent/src/core/tools/resume-session.ts` — provides shared session-ID-to-file resolution.
- `packages/coding-agent/src/core/tools/index.ts` — registers the tool in built-in inventories and factories.
- `packages/coding-agent/src/core/agent-session-runtime.ts` — relocates the persisted session, binds safe-boundary recovery, and repairs invalid process cwd.
- `packages/coding-agent/src/core/session-cwd.ts` — selects the nearest existing directory parent.
- `packages/coding-agent/src/core/agent-session.ts` — invokes recovery before idle runs and after completed turns.
- `packages/coding-agent/src/core/extensions/loader.ts` — binds factory-time `ExtensionAPI.cwd`.
- `packages/coding-agent/src/core/sdk.ts` — supplies session cwd to provider stream calls.
- `packages/ai/src/types.ts` — declares optional per-call `StreamOptions.cwd`.
- `packages/coding-agent/src/core/extensions/types.ts` — exposes optional runtime relocation on extension contexts.
- `packages/coding-agent/src/core/extensions/runner.ts` — forwards extension-context relocation to the active runtime.
- `packages/coding-agent/extensions/bwrap/src/index.ts` — rebuilds unsandboxed file-tool definitions from current cwd per execution.

## Tests asserting this spec

- `packages/coding-agent/test/suite/change-working-directory-tool.test.ts`
- `packages/coding-agent/test/suite/change-working-directory-mixed-batch.test.ts`
- `packages/coding-agent/test/suite/agent-session-runtime.test.ts`
- `packages/coding-agent/test/session-manager/file-operations.test.ts`

## Known gaps (current cycle)

- [ ] Verify automatic recovery boundaries, notices, directory-parent selection, extension factory cwd, and per-session provider stream cwd against the implementation's targeted tests.

## Out of scope

- Switching or resuming the referenced session.
- Modifying the referenced session's cwd or transcript.
- Inferring cwd from goal text, prompts, repository names, or process activity when the referenced session records a different cwd.
