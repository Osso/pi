# Bubblewrap sandbox backend

The bwrap sandbox backend lives under `packages/coding-agent/extensions/bwrap/`. It is an extension/backend, not a process wrapper for Pi itself: the host Pi process stays outside bubblewrap and selected tool workers are spawned through `bwrap` only for explicit `read-only` and `workspace-write` profiles.

## Sandbox shape

For sandbox-required profiles, the backend builds a bubblewrap command that:

- bind-mounts only required runtime paths (`/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/etc`, and `/nix` when present) plus explicit language/runtime support paths read-only;
- does not bind host `/`, `/home`, `/syncthing`, `/run`, or `/var` into the sandbox by default;
- overlays `/tmp` with a tmpfs;
- creates `/tmp/pi-home` and sets `HOME`, `TMPDIR`, and `XDG_CONFIG_HOME` to sandbox-local paths;
- creates empty parent directories for the active cwd and overlays only that workspace as read-only for `read-only` or read-write for `workspace-write`;
- shares the host network namespace, because this backend currently targets filesystem isolation only;
- uses `--clearenv` and a filtered environment (`HOME`, `PATH`, locale, terminal hints, `USER`, and only adapter-resolved Pyrun `PYTHONPATH`) instead of inheriting provider keys, arbitrary host `PYTHONPATH`, or host credential variables.

When launching a runtime runner, the backend also read-only mounts its resolved executable, absolute runner arguments, and `PYTHONPATH` entries when they are outside the workspace and not already available from system mounts. This permits the selected runtime to start without broad host mounts.

`full-access` and a missing explicit sandbox setting resolve to no sandbox profile, so the extension delegates to local tool and runtime implementations.

## Tool routing

The extension overrides the built-in file tools with same-name tool registrations, following the Gondolin extension pattern. File operations execute small Node workers inside bwrap to preserve the built-in result shapes while keeping filesystem access inside the sandbox. The worker rejects lexical path escapes and symlinks that resolve outside the active workspace for read/write/stat/readdir/access/find/grep operations. `bash` and `user_bash` use a `BashOperations` backend that spawns the requested shell command through bwrap.

Pyrun remains a default-loaded first-party extension. Under a sandbox-required profile, `pyrun_eval` starts its canonical runner through the bwrap backend rather than being blocked. Its Pi bridge is disabled: it receives no Pi capability snapshot and cannot make bridge requests. Outside a sandbox-required profile it retains normal local runner and Pi bridge behavior.

Hostrun uses the same runner path when its extension is loaded, but Hostrun is not default-loaded. It is an opt-in extension. Under a sandbox-required profile, `hostrun_eval` starts its canonical runner through bwrap with its Pi bridge disabled; otherwise it retains normal local runner and bridge behavior. The bwrap backend does not hard-block either runtime solely because sandboxing is selected.

## Loading

The bwrap and Pyrun packages are default first-party extensions, but enforcement is inactive until `sandboxProfile` is explicitly set in global or project settings. Systems without `bwrap` still start normally unless the user has selected `read-only` or `workspace-write`. Selecting `full-access` explicitly disables bwrap enforcement. Hostrun can use the same backend only after the user loads its extension.

Enabled host-side extension tools and hooks remain trusted capabilities outside this selected worker-routing boundary.
