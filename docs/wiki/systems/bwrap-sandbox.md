# Bubblewrap sandbox backend

The bwrap sandbox backend lives under `packages/coding-agent/extensions/bwrap/`. It is an extension/backend, not a process wrapper for Pi itself: the host Pi process stays outside bubblewrap and only tool workers are spawned through `bwrap`.

## Sandbox shape

For explicit sandbox-required profiles (`read-only`, `workspace-write`), the backend builds a bubblewrap command that:

- bind-mounts only required runtime paths (`/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/etc`, and `/nix` when present) plus explicit language/runtime support paths read-only;
- does not bind host `/`, `/home`, `/syncthing`, `/run`, or `/var` into the sandbox by default;
- overlays `/tmp` with a tmpfs;
- creates `/tmp/pi-home` and sets `HOME`, `TMPDIR`, and `XDG_CONFIG_HOME` to sandbox-local paths;
- creates empty parent directories for the active cwd and overlays only that workspace as read-only for `read-only` or read-write for `workspace-write`;
- shares the host network namespace, because this backend currently targets filesystem isolation only;
- uses `--clearenv` and a filtered environment (`HOME`, `PATH`, locale, terminal hints, and explicit `PYTHONPATH`) instead of inheriting provider keys or host credential variables.

`full-access` and a missing explicit sandbox setting resolve to no sandbox profile, so the extension delegates to local tool implementations.

## Tool routing

The extension overrides the built-in file tools with same-name tool registrations, following the Gondolin extension pattern. File operations execute small Node workers inside bwrap to preserve the built-in result shapes while keeping filesystem access inside the sandbox. The worker rejects lexical path escapes and symlinks that resolve outside the active workspace for read/write/stat/readdir/access/find/grep operations. `bash` and `user_bash` use a `BashOperations` backend that spawns the requested shell command through bwrap.

`pyrun_eval` remains owned by the first-party Pyrun extension. While a sandbox-required profile is active, the bwrap extension blocks `pyrun_eval` with a hard tool gate instead of allowing unsandboxed Python to run or registering a duplicate `pyrun_eval` tool. A future integration needs a shared sandbox runner hook so Pyrun can execute inside bwrap without conflicting with the first-party tool registration.

## Loading

The package is a default first-party extension, but enforcement is inactive until `sandboxProfile` is explicitly set in global or project settings. Systems without `bwrap` still start normally unless the user has selected `read-only` or `workspace-write`. Selecting `full-access` explicitly disables bwrap enforcement.
