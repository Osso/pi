# Session Lifecycle Hooks

Module boundary: extension API contract, not a standalone first-party extension module.

Session lifecycle hooks let an extension observe and, at key points, cancel or replace the session's own state transitions: startup, shutdown, switching, forking, compaction, and tree navigation, plus resource discovery and project-trust prompts. Pi provides these natively as in-process extension events with a discriminating `reason`/`position` field and, for the "before_*" events, a cancellable result. The contract lives in `packages/coding-agent/src/core/extensions/types.ts` (event + result types, `on` overloads) and is emitted from the session runtime. How it works belongs in docs/wiki/systems/session-lifecycle-hooks.md.

## What it must do

### Start / shutdown

- [x] `session_start` fires with `reason` ∈ {startup, reload, new, resume, fork, restart}; for new/resume/fork/restart it carries `previousSessionFile` (`agent-session-runtime-events.test.ts:106,120,132` and `2860-replaced-session-context.test.ts` assert the emitted `reason`/`previousSessionFile`).
- [x] `session_shutdown` fires before a runtime is torn down with `reason` ∈ {quit, reload, new, resume, fork, restart} and a `targetSessionFile` when caused by session replacement (`agent-session-runtime-events.test.ts:119,131` and `2860-replaced-session-context.test.ts`).
- [x] On a `new`/`resume` switch the ordering is `session_before_switch` → `session_shutdown` → `session_start` (`agent-session-runtime-events.test.ts:118-120,130-132`).

### Switch / fork (cancellable)

- [x] `session_before_switch` fires with `reason` ∈ {new, resume} and `targetSessionFile`; a handler may return `{ cancel: true }` (`agent-session-runtime-events.test.ts:118,130` assert the event; cancel result type at types.ts).
- [ ] `session_before_fork` fires with `entryId` and `position` ∈ {before, at}; a handler may return `{ cancel?, skipConversationRestore? }`.

### Compaction (cancellable / replaceable)

- [x] `session_before_compact` fires with `preparation`, `branchEntries`, optional `customInstructions`, and an `AbortSignal`; a handler may return `{ cancel: true }` to abort or `{ compaction }` to supply its own result (`compaction-extensions.test.ts:55,159` "should allow extensions to cancel compaction").
- [x] `session_compact` fires after compaction with the resulting `compactionEntry` and a `fromExtension` flag (`compaction-extensions.test.ts:153-155`).

### Tree navigation (cancellable / replaceable)

- [x] `session_before_tree` fires with a `TreePreparation` and `AbortSignal`; a handler may return `{ cancel: true }` to abort navigation (and clear branch-summary state) (`suite/regressions/3688-tree-cancel-compacting.test.ts:18,32`).
- [ ] `session_before_tree` may also return `{ summary, customInstructions, replaceInstructions, label }` to customize the branch summary.
- [ ] `session_tree` fires after navigation with `newLeafId`, `oldLeafId`, optional `summaryEntry`, and `fromExtension`.

### Discovery / trust

- [x] `project_trust` fires so an extension can participate in the project-trust decision (`extensions-runner.test.ts:89`).
- [ ] `resources_discover` fires with `cwd` and a `reason`, letting an extension contribute skill/prompt/theme paths (aggregated by `emitResourcesDiscover`).

## How it works

- See docs/wiki/systems/session-lifecycle-hooks.md (stub).
- Existing operator/author docs: `packages/coding-agent/docs/extensions.md` (lifecycle flow diagram ~line 280) and `packages/coding-agent/docs/compaction.md`.

## Implementation inventory

- `packages/coding-agent/src/core/extensions/types.ts:545-552` — `SessionStartEvent` (`reason`, `previousSessionFile`).
- `packages/coding-agent/src/core/extensions/types.ts:554-566` — `SessionBeforeSwitchEvent`, `SessionBeforeForkEvent` (`entryId`, `position`).
- `packages/coding-agent/src/core/extensions/types.ts:568-590` — `SessionBeforeCompactEvent` (signal), `SessionCompactEvent`, `SessionShutdownEvent`.
- `packages/coding-agent/src/core/extensions/types.ts:592-621` — `TreePreparation`, `SessionBeforeTreeEvent`, `SessionTreeEvent`.
- `packages/coding-agent/src/core/extensions/types.ts:623-631` — `SessionEvent` union.
- `packages/coding-agent/src/core/extensions/types.ts:984` — `ExtensionEvent` union includes `ProjectTrustEvent`, `ResourcesDiscoverEvent`, `SessionEvent`.
- `packages/coding-agent/src/core/extensions/types.ts:1125-1140` — `on(...)` overloads for `project_trust`, `resources_discover`, and all eight session events, with cancellable result types on the `before_*` variants.
- `packages/coding-agent/src/core/extensions/runner.ts:1046` — `emitResourcesDiscover`: aggregates skill/prompt/theme paths across extensions.

## Tests asserting this spec

- `packages/coding-agent/test/agent-session-runtime-events.test.ts:92,118,130` — start/shutdown/switch ordering and `reason`/file fields for new/resume.
- `packages/coding-agent/test/compaction-extensions.test.ts:55,153,159` — `session_before_compact` cancel and `session_compact` after-event.
- `packages/coding-agent/test/suite/regressions/3688-tree-cancel-compacting.test.ts:18` — `session_before_tree` `{ cancel: true }` clears branch-summary state.
- `packages/coding-agent/test/extensions-runner.test.ts:89` — `project_trust` event.

## Known gaps (current cycle)

- No dedicated test for `session_before_fork` (cancel / `skipConversationRestore`) or the `fork` reason on `session_start`/`session_shutdown`.
- No dedicated test for `session_tree` (after-event) or the `session_before_tree` summary-customization result fields.
- No dedicated test for `resources_discover` path aggregation.

## Out of scope

- The compaction algorithm itself (token budgeting, summary prompt) — see docs/specs/ for compaction once specced; this spec covers only the cancel/replace hook contract.
- Per-LLM-call context rewriting — see docs/specs/prompt-context-hooks.md.
