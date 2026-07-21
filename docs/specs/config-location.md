# Config Location

Module boundary: core configuration path resolution, not a first-party extension module.

Pi stores global user configuration under the XDG config tree instead of the legacy `~/.pi` tree. Project-local configuration remains in each workspace's `.pi/` directory. The global agent directory is the base for user settings, auth, prompt history, sessions, tools, themes, prompts, skills, extensions, and rules. The control database is state, not config, and is resolved under the global state root. How it works belongs in [docs/wiki/systems/config-location.md](../wiki/systems/config-location.md).

## What it must do

### Global config root

- [x] The default global config root is `$XDG_CONFIG_HOME/pi` when `XDG_CONFIG_HOME` is set.
- [x] The default global agent directory is `$XDG_CONFIG_HOME/pi/agent` when `XDG_CONFIG_HOME` is set.
- [x] When `XDG_CONFIG_HOME` is unset, the default global config root is `~/.config/pi`.
- [x] When `XDG_CONFIG_HOME` is unset, the default global agent directory is `~/.config/pi/agent`.
- [x] `PI_CODING_AGENT_DIR` overrides the default agent directory and remains the highest-priority path setting.

### Global state root

- [x] The default global state root is `$XDG_STATE_HOME/pi` when `XDG_STATE_HOME` is set.
- [x] When `XDG_STATE_HOME` is unset, the default global state root is `~/.local/state/pi`.
- [x] `PI_CODING_AGENT_STATE_DIR` overrides the global state root.
- [x] The configured control database is `control.sqlite` under the global state root, not under the agent config directory.
- [x] Startup does not fall back to or migrate a legacy control database from the agent config directory.
- [x] Deployment moves the live control database to the state-root path only while all runtimes are stopped.

### Legacy compatibility

- [x] The legacy `~/.pi/agent` path remains available as an explicit migration source.
- [ ] Startup migration moves an existing legacy `~/.pi/agent` tree to `~/.config/pi/agent` when the new directory does not already exist.
- [ ] Startup migration never overwrites an existing `~/.config/pi/agent` tree.
- [ ] Backward compatibility leaves `~/.pi` as a symlink to `~/.config/pi` when the legacy root can be replaced safely.

### Project-local config

- [x] Project-local config continues to use `.pi/` inside the workspace; it is not moved under `~/.config/pi`.
- [x] Project-local settings, rules, goals, and extension resources keep their existing `.pi/...` paths.

### Personal AgentConfig links

- [ ] On this machine, the canonical personal configuration source is `~/AgentConfig` (singular), not `~/AgentsConfig`.
- [ ] `~/.config/pi/agent/skills` may be a symlink to `~/AgentConfig/skills`.
- [ ] `~/.config/pi/agent/rules` may be a symlink to `~/AgentConfig/rules`.
- [ ] Symlink setup must not replace a real existing directory without an explicit user migration decision.

## How it works

- [docs/wiki/systems/config-location.md](../wiki/systems/config-location.md) (stub — not yet written).

## Implementation inventory

- `packages/coding-agent/src/config.ts` — Resolves global user config and state paths, legacy path helpers, and environment overrides.
- `packages/coding-agent/src/core/session-control-db.ts` — Resolves the configured control database under the state root and creates missing state directories before writes.
- `packages/coding-agent/src/core/settings-manager.ts` — Reads global settings from the resolved agent directory and project settings from `.pi/settings.json`.
- `packages/coding-agent/src/core/resource-loader.ts` — Loads global rules from the resolved agent directory and project rules from `.pi/rules`.
- `packages/coding-agent/src/core/package-manager.ts` — Discovers user resources under the resolved agent directory and project resources under `.pi/`.

## Tests asserting this spec

- `packages/coding-agent/test/config-paths.test.ts` — XDG config/state roots, fallback defaults, explicit overrides, control-database path/isolation, state-directory creation, and legacy migration-source path.
- `packages/coding-agent/test/settings-manager.test.ts` — project-local `.pi/settings.json` remains the project settings path.
- `packages/coding-agent/test/package-manager.test.ts` — project-local `.pi` resources remain workspace-scoped.

## Known gaps (current cycle)

- [x] Implement and test unset-`XDG_CONFIG_HOME` default paths.
- [ ] Implement and test legacy `~/.pi/agent` migration without overwriting existing XDG config.
- [x] Set up this machine's `~/.config/pi/agent/skills` and `rules` symlinks to `~/AgentConfig`.

## Out of scope

- Moving project-local `.pi/` directories.
- Migrating unrelated tools that still read `~/.pi` directly.
- Runtime editing or synchronization of the `~/AgentConfig` repository.
