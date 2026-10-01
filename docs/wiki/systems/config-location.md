# Config location

[Contract](../../specs/config-location.md)

## Resolution and consumers

[`config.ts`](../../../packages/coding-agent/src/config.ts) resolves three separate roots:

| Purpose | Override | XDG default | Unset-XDG default |
| --- | --- | --- | --- |
| Agent configuration | `PI_CODING_AGENT_DIR` | `$XDG_CONFIG_HOME/pi/agent` | `~/.config/pi/agent` |
| State | `PI_CODING_AGENT_STATE_DIR` | `$XDG_STATE_HOME/pi` | `~/.local/state/pi` |
| Cache | None | `$XDG_CACHE_HOME/pi` | `~/.cache/pi` |

Overrides support tilde expansion. Agent-relative helpers resolve auth, settings, models, themes, tools, prompts and sessions. [`session-control-db.ts`](../../../packages/coding-agent/src/core/session-control-db.ts) puts `control.sqlite` under the state root and creates its parent before opening for writes; callers can supply an explicit directory for isolation.

[`settings-manager.ts`](../../../packages/coding-agent/src/core/settings-manager.ts) reads global `settings.json` under the agent directory and project `.pi/settings.json`. [`resource-loader.ts`](../../../packages/coding-agent/src/core/resource-loader.ts) loads global agent rules and, for trusted projects, project `.pi/rules`. [`package-manager.ts`](../../../packages/coding-agent/src/core/package-manager.ts) keeps project resources rooted in workspace `.pi/`.

## Limits and requirement status

`getLegacyAgentDir()` exposes `~/.pi/agent` as a migration source, not a startup fallback. Automatic legacy-tree migration and creation of a compatibility `~/.pi` symlink are unimplemented requirements. Personal `~/AgentConfig` symlinks are machine setup, not behavior implemented by these resolvers; this page does not verify their current state. Moving a live control database is a deployment requirement, not something startup performs.

Installed Pi documentation still contains legacy `~/.pi` examples; checkout path helpers above determine this implementation's defaults.

## Test evidence

Inspected, not run: [`config-paths.test.ts`](../../../packages/coding-agent/test/config-paths.test.ts) (roots, overrides, control DB isolation/creation, legacy helper), [`model-catalog-cache.test.ts`](../../../packages/coding-agent/test/model-catalog-cache.test.ts) (cache roots), [`settings-manager.test.ts`](../../../packages/coding-agent/test/settings-manager.test.ts) and [`package-manager.test.ts`](../../../packages/coding-agent/test/package-manager.test.ts) (project-local resources).
