# Bubblewrap sandbox backend

Module boundary: default-loaded first-party extension package.

The bubblewrap sandbox backend is a Linux extension that routes Pi tool workers through a `bwrap` process while leaving the host Pi process outside the sandbox. How it works belongs in [../wiki/systems/bwrap-sandbox.md](../wiki/systems/bwrap-sandbox.md).

## What it must do

### Profile behavior

- [x] Treat explicit `read-only` and `workspace-write` settings as sandbox-required profiles.
- [x] Treat `full-access` and missing explicit sandbox settings as unsandboxed/bypass mode.
- [x] Fail closed when a sandbox-required profile is active and `bwrap` is unavailable.

### Filesystem isolation

- [x] Mount required host runtime paths read-only (`/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/etc`, and `/nix` when present) without mounting host `/`, `/home`, `/syncthing`, `/run`, or `/var`.
- [x] Mount the active workspace read-only for `read-only` and writable for `workspace-write`.
- [x] Provide a fake `HOME`, `TMPDIR`, and `XDG_CONFIG_HOME` inside the sandbox.
- [x] Use `--clearenv` and explicit environment variables so provider keys and other credentials are not passed into sandboxed workers by default.
- [x] Reject file-worker paths and symlinks that escape the active workspace.

### Tool routing

- [x] Route built-in `read`, `write`, `edit`, `ls`, `find`, and `grep` through the bwrap backend when sandboxed.
- [x] Route built-in `bash` and interactive `user_bash` through the bwrap backend when sandboxed.
- [x] Route `pyrun_eval` through a persistent bwrap-hosted Pyrun runner when sandboxed.
- [x] Start sandboxed Pyrun without inheriting `process.env`.
- [x] Disable the Pyrun Pi bridge while Pyrun runs in a sandboxed profile.
- [x] Restart the persistent Pyrun runner when sandbox profile or cwd changes.
- [x] Register a hard tool gate so sandbox-required profiles cannot silently proceed unsandboxed when `bwrap` is unavailable.

## How it works

- [../wiki/systems/bwrap-sandbox.md](../wiki/systems/bwrap-sandbox.md)

## Implementation inventory

- `packages/coding-agent/extensions/bwrap/src/backend.ts` — builds and executes bubblewrap invocations for sandbox-required profiles.
- `packages/coding-agent/extensions/bwrap/src/index.ts` — extension entry point; overrides file tools, bash/user_bash, and `pyrun_eval`.
- `packages/coding-agent/extensions/pyrun/src/index.ts` — exports reusable Pyrun tool construction so the bwrap extension can preserve Pyrun prompt/rendering behavior.

## Tests asserting this spec

- `packages/coding-agent/test/bwrap-extension.test.ts` — bwrap invocation shape, profile mapping, fail-closed availability checks, environment filtering, file-worker workspace containment, and symlink escape rejection.
- `packages/coding-agent/test/pyrun-extension.test.ts`

## Known gaps (current cycle)

- [ ] Add integration tests that execute fake or real bwrap for routed tool execution without requiring host-specific bubblewrap availability.
- [x] Load the first-party bwrap extension by default while keeping enforcement inactive until the user explicitly chooses a sandbox profile, so default startup does not fail on systems without bubblewrap.

## Out of scope

- Network egress policy. This backend shares the host network namespace and only targets filesystem/process isolation.
- macOS or Windows sandboxing. This backend is Linux/bubblewrap-only.
