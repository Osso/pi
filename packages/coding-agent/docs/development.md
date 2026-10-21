# Development

See [AGENTS.md](https://github.com/earendil-works/pi-mono/blob/main/AGENTS.md) for additional guidelines.

## Setup

```bash
git clone https://github.com/earendil-works/pi-mono
cd pi-mono
npm install
npm run build
```

Run from source:

```bash
/path/to/pi-mono/pi-test.sh
```

The script can be run from any directory. Pi keeps the caller's current working directory.

## Source deployment

From the repository root:

```bash
./deploy.sh                 # Local installation only (default)
./deploy.sh --agent-server  # Local installation, then fixed agent-server runtime update
```

Both invocations run checks, build the host-platform binary, and install locally once. `--agent-server` then ships that identical public runtime via SSH/rsync to `osso@agent-server`, replacing the existing real directory `/home/osso/.local/share/pi` atomically after staged validation. It then updates each other agent-server account with its own installation (currently `allison`): the public runtime is copied to a world-readable `/tmp` stage, and `authsudo -u <account>` runs the helper's `--update-local` mode with a clean environment, so the account's install and launcher are replaced atomically and its private files are untouched. A failed account update fails the deploy after osso's install is already activated. The remote host must support the built platform and have Python 3 and rsync available; SSH must work non-interactively. No blanket clean-checkout gate is imposed.

Remote activation validates `pi --version` before and after replacement and rolls back the remote runtime if post-activation validation fails. It preserves the remote launcher wrapper, configuration, credentials, sessions, and services; it does not restart running sessions. Local resident-service behavior remains unchanged; see [Supervisor deployment](../../../docs/wiki/systems/supervisor-service.md#deployment). Use `PI_DEPLOY_CONFIGURE_RESIDENT_SERVICES=skip` to leave local resident services untouched.

Runtime rsync uses compression and a 900-second deadline per transfer attempt, separate from its 60-second I/O idle timeout. Transient transfer failures, including SSH exit 255, are retried up to three attempts; activation is never retried.

This is not a transaction across both hosts: local installation may already be updated when the remote step fails. Failure returns nonzero and identifies the remote staging directory for inspection; a lost activation connection may leave remote success uncertain.

### Fresh per-user public-runtime installation

On Linux, run as the intended account with its explicit `HOME` and an already staged public bundle:

```bash
HOME=/home/allison python3 /path/to/pi/scripts/deploy-agent-server-runtime.py --install-local /path/to/public-runtime
/home/allison/.local/bin/pi --version
```

`HOME` selects paths, not account identity: invoke as `allison`, not as `osso` or root. This installs into `Path.home()/.local/share/pi` and creates `~/.local/bin/pi` as an executable symlink. Both paths must be absent, including dangling symlinks; this mode never updates an existing installation. It rejects private entries and symlinks, copies into a current-user-owned private staging directory, validates the copy, atomically activates without replacing an existing target, then validates the installed version before linking the launcher. Validation or launcher creation failure removes the new runtime; staging is cleaned on exit.

No configuration, credentials, sessions, profiles, services, or other accounts are modified. The fixed `osso@agent-server` shipping/update paths remain unchanged. Focused filesystem and subprocess tests:

```bash
python3 scripts/test-deploy-agent-server-runtime.py
```

### Existing per-user public-runtime update

On `agent-server`, run as `allison` with its explicit `HOME` and a staged verified public bundle:

```bash
HOME=/home/allison python3 /path/to/pi/scripts/deploy-agent-server-runtime.py --update-local /path/to/public-runtime
HOME=/home/allison /home/allison/.local/bin/pi --version
```

`--update-local` selects the effective account's home from the account database, not `HOME`. Setting `HOME` does not switch identity; never invoke as `osso` or root to update Allison. Explicit `HOME` keeps subsequent Pi invocations in Allison's environment.

The mode requires a current-account-owned real `~/.local/share/pi` directory and a current-account-owned `~/.local/bin/pi` symlink resolving to its existing `pi` executable. Missing installations, custom wrappers, wrong targets, and dangling launchers fail explicitly; there is no fresh-install fallback.

Only the public bundle is copied into a private current-account staging directory. Private entries and symlinks are rejected. Existing atomic activation validates the staged and installed versions and rolls back on post-activation validation failure; staging is cleaned on exit. The launcher, authentication, settings, sessions, and other accounts remain unchanged. Never stage another account's private state. This mode neither restarts live sessions nor proves their adoption of the updated runtime.

Default `osso@agent-server` shipping and fresh `--install-local` behavior are unchanged. The focused test command above covers account selection with mismatched `HOME`, launcher/private-state preservation, invalid targets and payloads, and validation rollback; test coverage is not deployment proof.

## Forking / Rebranding

Configure via `package.json`:

```json
{
  "piConfig": {
    "name": "pi",
    "configDir": ".pi"
  }
}
```

Change `name`, `configDir`, and `bin` field for your fork. Affects CLI banner, config paths, and environment variable names.

## Path Resolution

Three execution modes: npm install, standalone binary, tsx from source.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Live Debug REPL

`/debug` enables a privileged JavaScript REPL for the current Pi process. Attach from another terminal with the session ID shown by `/session-id`:

```bash
pi debug attach <session-id>
```

The REPL exposes live runtime state under `pi`. Run `/debug off` in the Pi session to close the endpoint and attached clients. Enable it only for trusted local debugging; evaluated JavaScript has the same system access as Pi.

## Testing

```bash
./test.sh                         # Run non-LLM tests (no API keys needed)
npm test                          # Run all tests
npm test -- test/specific.test.ts # Run specific test
```

## Project Structure

```
packages/
  ai/           # LLM provider abstraction
  agent/        # Agent loop and message types  
  tui/          # Terminal UI components
  coding-agent/ # CLI and interactive mode
```
