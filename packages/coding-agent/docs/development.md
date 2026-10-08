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

Both invocations run checks, build the host-platform binary, and install locally once. `--agent-server` then ships that identical public runtime via SSH/rsync to `osso@agent-server`, replacing the existing real directory `/home/osso/.local/share/pi` atomically after staged validation. The remote host must support the built platform and have Python 3 and rsync available; SSH must work non-interactively. No blanket clean-checkout gate is imposed.

Remote activation validates `pi --version` before and after replacement and rolls back the remote runtime if post-activation validation fails. It preserves the remote launcher wrapper, configuration, credentials, sessions, and services; it does not restart running sessions. Local resident-service behavior remains unchanged; see [Supervisor deployment](../../../docs/wiki/systems/supervisor-service.md#deployment). Use `PI_DEPLOY_CONFIGURE_RESIDENT_SERVICES=skip` to leave local resident services untouched.

This is not a transaction across both hosts: local installation may already be updated when the remote step fails. Failure returns nonzero and identifies the remote staging directory for inspection; a lost activation connection may leave remote success uncertain.

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
