# Bubblewrap sandbox backend

Module boundary: default-loaded first-party extension package.

The bubblewrap sandbox backend is a Linux extension that routes selected Pi tool workers through a `bwrap` process while leaving the host Pi process outside the sandbox. It is active only for explicit `read-only` and `workspace-write` profiles. How it works belongs in [../wiki/systems/bwrap-sandbox.md](../wiki/systems/bwrap-sandbox.md).

## What it must do

### Profile behavior

- [x] Treat explicit `read-only` and `workspace-write` settings as sandbox-required profiles.
- [x] Treat `full-access` and missing explicit sandbox settings as unsandboxed/bypass mode.
- [x] Fail closed when a sandbox-required profile is active and `bwrap` is unavailable.

### Filesystem and environment isolation

- [x] Mount required host runtime paths read-only (`/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/etc`, and `/nix` when present) without mounting host `/`, `/home`, `/syncthing`, `/run`, or `/var`.
- [x] Mount the active workspace read-only for `read-only` and writable for `workspace-write`.
- [x] Mount runtime executables, explicit runner arguments, and adapter-resolved `PYTHONPATH` entries outside the workspace read-only when a sandboxed runtime requires them; never propagate arbitrary inherited `PYTHONPATH` entries.
- [x] Provide sandbox-local `HOME`, `TMPDIR`, and `XDG_CONFIG_HOME`.
- [x] Use `--clearenv` and an explicit filtered environment so provider keys and other host credentials are not passed into sandboxed workers by default.
- [x] Reject file-worker paths and symlinks that escape the active workspace.

### Tool routing

- [x] Route built-in `read`, `write`, `edit`, `ls`, `find`, and `grep` through the bwrap backend when sandboxed.
- [x] Route built-in `bash` and interactive `user_bash` through the bwrap backend when sandboxed.
- [x] Keep default-loaded `pyrun_eval` available: run its runner inside bwrap for sandbox-required profiles, with the Pi bridge disabled.
- [x] Do not hard-block Pyrun merely because a sandbox-required profile is active.
- [x] Register a hard tool gate so sandbox-required profiles cannot silently proceed unsandboxed when `bwrap` is unavailable.

## How it works

- [../wiki/systems/bwrap-sandbox.md](../wiki/systems/bwrap-sandbox.md)

## Implementation inventory

- `packages/coding-agent/extensions/bwrap/src/backend.ts` — builds bubblewrap invocations for sandbox-required profiles, including runner commands.
- `packages/coding-agent/extensions/bwrap/src/index.ts` — extension entry point; routes file tools and bash/user_bash.
- `packages/coding-agent/extensions/pyrun/src/index.ts` — default-loaded Pyrun extension; selects local or bwrap runner execution by profile.

## Tests asserting this spec

- `packages/coding-agent/test/bwrap-extension.test.ts` — bwrap invocation shape, profile mapping, fail-closed availability checks, environment filtering, runner-path validation, file-worker workspace containment, and real bwrap read-only/workspace-write enforcement when bubblewrap is executable.
- `packages/coding-agent/test/pyrun-extension.test.ts` — sandboxed Pyrun runner and disabled Pi bridge.

## Known gaps (current cycle)

No current-cycle gaps.

## Out of scope

- Network egress policy. This backend shares the host network namespace and only targets filesystem/process isolation.
- macOS or Windows sandboxing. This backend is Linux/bubblewrap-only.
- Sandboxing arbitrary host-side extension tools or hooks. Enabled extensions remain trusted host capabilities outside this selected worker-routing boundary.
