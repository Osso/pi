# Bubblewrap sandbox backend

Module boundary: default-loaded first-party extension package.

The bubblewrap sandbox backend is a Linux extension that routes selected Pi tool workers through a `bwrap` process while leaving the host Pi process outside the sandbox. It is active only for explicit `read-only` and `workspace-write` profiles. How it works belongs in [../wiki/systems/bwrap-sandbox.md](../wiki/systems/bwrap-sandbox.md).

## What it must do

### Profile behavior

- [x] Treat explicit `read-only` and `workspace-write` settings as sandbox-required profiles.
- [x] Treat a missing session override or session `inherit` as no session override; missing project/global settings and `full-access` resolve to unsandboxed/bypass mode.
- [x] Apply sandbox profile precedence as session override, then project setting, then global setting.
- [x] Persist session overrides in the control-session database keyed by canonical session path and validated against the exact session ID, so restart/resume retains the policy without affecting new, forked, or unrelated sessions.
- [x] Let `/sandbox` select global, project, or session scope; session scope can explicitly inherit project/global settings.
- [x] Support deterministic `/sandbox <read-only|workspace-write|full-access|inherit> <session|project|global>` arguments; `inherit` is valid only for session scope.
- [x] Fail closed when a sandbox-required profile is active and `bwrap` is unavailable.

### Filesystem and environment isolation

- [x] Mount required host runtime paths read-only (`/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/etc`, and `/nix` when present) without mounting host `/`, `/home`, `/syncthing`, `/run`, or `/var`.
- [x] Mount the active workspace read-only for `read-only` and writable for `workspace-write`.
- [x] Mount runtime executables, explicit runner arguments, and adapter-resolved `PYTHONPATH` entries outside the workspace read-only when a sandboxed runtime requires them; resolve symlinked runner commands to their canonical target and never propagate arbitrary inherited `PYTHONPATH` entries.
- [x] Provide sandbox-local `HOME`, `TMPDIR`, and `XDG_CONFIG_HOME`.
- [x] Use `--clearenv` and an explicit filtered environment so provider keys and other host credentials are not passed into sandboxed workers by default.
- [x] Reject file-worker paths and symlinks that escape the active workspace.

### Tool routing

- [x] Route built-in `read`, `write`, `edit`, `ls`, `find`, and `grep` through the bwrap backend when sandboxed.
- [x] Route built-in `bash` and interactive `user_bash` through the bwrap backend when sandboxed.
- [x] Keep default-loaded `pyrun_eval` available: run its runner inside bwrap for sandbox-required profiles, with the Pi bridge disabled.
- [x] Do not hard-block Pyrun merely because a sandbox-required profile is active.
- [x] Register a hard tool gate so sandbox-required profiles cannot silently proceed unsandboxed when `bwrap` is unavailable.
- [x] In unsandboxed mode, resolve each local file-tool execution from current extension-context cwd rather than process startup cwd.

## How it works

- [../wiki/systems/bwrap-sandbox.md](../wiki/systems/bwrap-sandbox.md)

## Implementation inventory

- `packages/coding-agent/extensions/bwrap/src/backend.ts` — builds bubblewrap invocations for sandbox-required profiles, including runner commands.
- `packages/coding-agent/extensions/bwrap/src/index.ts` — extension entry point; routes file tools and bash/user_bash.
- `packages/coding-agent/extensions/approval-controls/src/index.ts` — exposes selector and deterministic `/sandbox` profile/scope arguments.
- `packages/coding-agent/src/core/session-control-db.ts` — persists one validated sandbox override per canonical session path with exact session-ID validation.
- `packages/coding-agent/src/core/session-manager.ts` — materializes a new session before saving its override and reads persisted session settings.
- `packages/coding-agent/src/core/settings-manager.ts` — resolves session, project, and global profile precedence.
- `packages/coding-agent/src/core/sdk.ts` — restores or clears the session overlay before runtime construction.
- `packages/coding-agent/src/core/extensions/runner.ts` — applies selector and direct-command changes to settings or control-session state.
- `packages/coding-agent/src/core/extensions/types.ts` — exposes sandbox mutation to extension command handlers.
- `packages/coding-agent/src/core/permissions/presets.ts` — defines sandbox profiles and persistence scopes.
- `packages/coding-agent/src/modes/interactive/components/sandbox-selector.ts` — selects profile and persistence scope, including session inheritance.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — connects selector choices to the active session runtime.
- `packages/coding-agent/extensions/pyrun/src/index.ts` — default-loaded Pyrun extension; selects local or bwrap runner execution by profile.

## Tests asserting this spec

- `packages/coding-agent/test/bwrap-extension.test.ts` — bwrap invocation shape, profile mapping, fail-closed availability checks, environment filtering, canonical runner-path validation, file-worker workspace containment, and real bwrap read-only/workspace-write enforcement when bubblewrap is executable.
- `packages/coding-agent/test/session-sandbox-profile.test.ts` — control-DB persistence, validation, relocation, cleanup, runtime restoration, precedence, and new/forked-session isolation.
- `packages/coding-agent/test/settings-manager.test.ts` — session/project/global sandbox-profile precedence.
- `packages/coding-agent/test/approval-selector.test.ts` — session scope and inheritance visibility/selection.
- `packages/coding-agent/test/approval-slash-commands.test.ts` — deterministic profile/scope arguments and inherit validation.
- `packages/coding-agent/test/pyrun-extension.test.ts` — sandboxed Pyrun runner and disabled Pi bridge.
- `packages/coding-agent/test/suite/regressions/session-sandbox-profile-restart.test.ts` — real-process session override, restart persistence, read-only write denial, sandboxed Pyrun execution, and new-session isolation.
- `packages/coding-agent/test/suite/change-working-directory-tool.test.ts` — unsandboxed file-tool cwd after relocation and process restart.

## Known gaps (current cycle)

No current-cycle gaps.

## Out of scope

- Network egress policy. This backend shares the host network namespace and only targets filesystem/process isolation.
- macOS or Windows sandboxing. This backend is Linux/bubblewrap-only.
- Sandboxing arbitrary host-side extension tools or hooks. Enabled extensions remain trusted host capabilities outside this selected worker-routing boundary.
