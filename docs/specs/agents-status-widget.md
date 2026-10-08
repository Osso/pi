# Agents status widget

Module boundary: first-party extension at `packages/coding-agent/extensions/agents-status/`, loaded only when multi-agent orchestration is active. It renders a compact, live list of sub-agents above the editor so the user can see what each agent is doing. Activity data comes from persisted `AgentSnapshot.currentActivity` (see [multi-agent](multi-agent.md)). Implementation detail belongs in `docs/wiki/systems/agents-status-widget.md`.

## What it must do

### Activity source

- [x] When a child tool call starts, its persisted `currentActivity` includes a `detail` summary built from the most descriptive string argument (`command`, `code`, `path`, `file_path`, `pattern`, `query`, `url`, `prompt`, `message`, `agentId`, in that priority order). The summary has its whitespace collapsed to one line and is truncated to 160 characters. It is omitted when no such argument exists (`packages/coding-agent/test/agents-status-extension.test.ts`, `packages/coding-agent/test/suite/agent-session-child-activity.test.ts`).

### Rendering

- [x] Render nothing when no agent is active and none finished within the last 10 seconds.
- [x] One line per agent: lifecycle icon, display name (padded to the widest shown name, capped at 24 columns), activity, and right-aligned elapsed time. A line never exceeds the terminal width; activity text is truncated first.
- [x] Activity text is `<tool> <detail>` for tool calls, `thinking` while the model runs, and `waiting for input`, `steering pending`, `cancelling`, `done`, `failed: <message>`, or `aborted` for other lifecycles.
- [x] For an active agent, elapsed time measures the current activity, falling back to agent creation when there is no activity. For a terminal agent, it is the total runtime.
- [x] Order sibling agents as waiting-for-input, steering-pending, running, cancelling, then terminal, most recently updated first within each group. Children render directly under their parent and are indented with `└`.
- [x] Show at most 5 agent rows, followed by a `+N more` line when more are visible.

### Liveness

- [ ] Re-render on every store agent update, and once per second while rows are visible so elapsed times advance. Verified by manual tmux smoke test only.

## How it works

- [docs/wiki/systems/agents-status-widget.md](../wiki/systems/agents-status-widget.md)

## Implementation inventory

- `packages/coding-agent/extensions/agents-status/src/index.ts`: widget extension that collects, orders, and renders rows.
- `packages/coding-agent/src/core/agent-activity-detail.ts`: builds the one-line tool-argument summary.
- `packages/coding-agent/src/core/agent-session.ts`: publishes child `currentActivity`, including `detail`.
- `packages/coding-agent/src/core/multi-agent-store.ts`: `AgentCurrentActivity` type.
- `packages/coding-agent/src/main.ts`: registers the extension alongside the other orchestration extensions.

## Tests asserting this spec

- `packages/coding-agent/test/agents-status-extension.test.ts`
- `packages/coding-agent/test/suite/agent-session-child-activity.test.ts`

## Known gaps (current cycle)

- [ ] Configurable keybinding to collapse or expand the widget.

## Out of scope

- Per-tool argument formatters: the generic key-priority summary covers the built-in tools.
