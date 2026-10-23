# Periodic checks operation

Bundled first-party extension `periodic-checks` implements the [scheduler contract](../../specs/periodic-checks.md). No remote-agent installation or mapping is needed.

## Discovery and disabling

After installing the bundled Pi build, remove superseded user-level `periodic-checks.ts` and `exit-command.ts` copies/symlinks and explicit old-path loading entries from the active Pi configuration. Keep only bundled registrations to avoid duplicate commands and timers. Preserve the host-private checklist.

Start a new Pi session or use `/reload` after updating Pi to discover `/periodic-checks` and `/exit`. Inspect inventory with `/extensions` or `pi extensions`.

To disable the extension, add its inventory name to settings, then reload:

```json
{
  "disabledExtensions": ["periodic-checks"]
}
```

See [extension settings](../../../packages/coding-agent/docs/settings.md). Disabling removes its command and scheduling. Without a checklist, the loaded extension already schedules no audits.

## Host-private checklist

Create `periodic-checks.md` at the current directory's Git root and keep it Git-ignored. Each host maintains its own file; neither Pi nor remote-agent deployment distributes it. Example Google OKF frontmatter and checklist:

```markdown
---
type: Periodic Checks
interval_seconds: 1800
---
# Periodic checks

Report Git status and test failures. No edits.
```

`type` is a nonempty string; `interval_seconds` is a positive safe integer in 1–2147483 seconds. Unknown metadata fields are allowed. The extension uses Pi's exported `parseFrontmatter`; it adds no YAML dependency. After adding a checklist that was missing at startup, run `/periodic-checks status` to discover it and arm its timer. Reload or start a new session after changing an armed schedule's metadata or restoring a checklist removed from an armed schedule. No checklist means no timer or audit; invalid metadata reports an error rather than selecting a default interval.

## Commands

- `/periodic-checks` or `/periodic-checks status` displays current state, checklist path, and active interval/relative countdown or disabled reason. Only when the timer is undefined and the cached disabled reason is `No checklist`, status retries startup discovery under the same runtime gates and arms a valid newly added file, waiting its full interval before the first audit. It does not trigger an audit or reread metadata/reset the countdown of an armed schedule. Invalid-metadata startup, shutdown, and removed-previously-armed checklist states still require reload or a new session.
- `/periodic-checks run` requests an immediate audit without changing the regular countdown. `Periodic audit starting` precedes dispatch settlement; `Periodic audit started` means dispatch was accepted, not that the audit completed or findings arrived.

Both commands remain available while main is busy. See the [command contract](../../specs/periodic-checks.md#commands) for output, timing, and refusal semantics.

## Runtime flow

`session_start` resolves the Git root and validates metadata before creating an interval timer. Main TUI/RPC sessions need the multi-agent store and active `spawn_agent`/`send_agent_message` tools; child sessions do not arm timers.

Each tick advances the stored schedule boundary and attempts direct `pi.callTool("spawn_agent", ...)` dispatch. A pending call or stored live `periodic-checks-audit` blocks overlap. The child is a fresh-context `explore` agent; its prompt rereads the checklist and requires report-only findings sent to the originating main session with successful-delivery confirmation. No model prompt asks main to start the audit. Schedule generations fence late results after reload or shutdown.

This timer runs only while the session is alive. The complete [audit policy](../../specs/periodic-checks.md#dispatch-and-audit-policy) remains canonical; the checklist does not authorize remediation.
