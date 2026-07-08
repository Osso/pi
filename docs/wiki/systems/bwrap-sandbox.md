# Bubblewrap sandbox backend

The bwrap sandbox backend lives under `packages/coding-agent/extensions/bwrap/`. It is an extension/backend, not a process wrapper for Pi itself: the host Pi process stays outside bubblewrap and only tool workers are spawned through `bwrap`.

## Sandbox shape

For sandbox-required profiles (`read-only`, `workspace-write`), the backend builds a bubblewrap command that:

- bind-mounts only required runtime paths (`/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/etc`, and `/nix` when present) plus explicit language/runtime support paths read-only;
- does not bind host `/`, `/home`, `/syncthing`, `/run`, or `/var` into the sandbox by default;
- overlays `/tmp` with a tmpfs;
- creates `/tmp/pi-home` and sets `HOME`, `TMPDIR`, and `XDG_CONFIG_HOME` to sandbox-local paths;
- creates empty parent directories for the active cwd and overlays only that workspace as read-only for `read-only` or read-write for `workspace-write`;
- shares the host network namespace, because this backend currently targets filesystem isolation only;
- uses `--clearenv` and a filtered environment (`HOME`, `PATH`, locale, terminal hints, and explicit `PYTHONPATH`) instead of inheriting provider keys or host credential variables.

`full-access` resolves to no sandbox profile, so the extension delegates to local tool implementations.

## Tool routing

The extension overrides the built-in file tools with same-name tool registrations, following the Gondolin extension pattern. File operations execute small Node workers inside bwrap to preserve the built-in result shapes while keeping filesystem access inside the sandbox. The worker rejects lexical path escapes and symlinks that resolve outside the active workspace for read/write/stat/readdir/access/find/grep operations. `bash` and `user_bash` use a `BashOperations` backend that spawns the requested shell command through bwrap.

`pyrun_eval` reuses the first-party Pyrun tool definition and creates a `PyrunRunnerClient` whose command is bwrap and whose argv ends in the canonical Pyrun runner command. The extension keeps one persistent runner per active profile/cwd key and disposes/restarts it when that key changes. The sandboxed Pyrun path starts the bwrap runner with `process.env` inheritance disabled and disables the Pi bridge, so Python code cannot call host Pi capabilities such as `pi.tools.call`, `pi.commands.run`, session switching, restart, or agent/message helpers from inside the sandbox.

## Loading

The package is first-party but opt-in. It is not included in Pi's default extension factory list, so systems without `bwrap` still start normally. Load it through normal extension package discovery, for example by adding `packages/coding-agent/extensions/bwrap/` or its `src/index.ts` entry point to `settings.json` `extensions`, or by installing/enabling it as a Pi extension package.
