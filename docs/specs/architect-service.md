# Resident Architect Service

Module boundary: core resident SDK service.

The resident Architect is a systemd-supervised Sol advisor that preserves a dedicated cross-session transcript and sends evidence-backed coordination advice only to the affected session. It is not a dispatcher or remediation agent. Its transcript is persisted as an archived non-subagent session under `<agent-dir>/architect-sessions/`, so it remains available through Archived even though it is outside the Current Folder directory scope. Implementation details live in [../wiki/systems/architect-service.md](../wiki/systems/architect-service.md).

## What it must do

### Observation

- [x] Poll a bounded sessions snapshot already prefiltered to non-subagent main sessions with a
      current main listener and matching fresh `ok` health, one per live Pi process, deduplicated
      by session identity and excluding the Architect itself, every 30 seconds without prompting
      the model when state is unchanged. The model receives no raw listener or health fields.
      Historical same-PID sessions must not appear in either Architect or global session inventory.
- [x] Prompt on the initial session snapshot, material session/goal changes, or an atomically claimed request from the dedicated Architect request queue.
- [x] Treat `goal_json.completedAt` as completed-goal state only, not session termination. The
      model uses membership in the prefiltered sessions snapshot, never goal fields, as its only
      liveness evidence.
- [x] Ignore subagent and Architect-originated channel posts as architect requests.
- [x] Open observer state through SQLite read-only access without applying writer-oriented database configuration.

### Advice

- [x] Keep the standard Pi tool set available except Architect-disabled `broadcast`, `ask_architect`, and `contact_parent` while the `read-only` bwrap profile routes file, shell, and default-loaded Pyrun runner workers through Bubblewrap. Pyrun remains available with its Pi bridge disabled; Hostrun is opt-in and uses the same runner mode when loaded. The removed `contact_supervisor` name is not a compatibility alias.
- [x] Send evidence-backed advice through direct `send_agent_message` delivery to the originating session; block `broadcast` and global `channel_post` fanout.
- [x] Never dispatch agents, edit files, restart sessions, or remediate autonomously.

### Service lifecycle

- [x] Run `~/.local/bin/pi architect` as a systemd user service using `openai-codex/gpt-5.6-sol`.
- [x] Preserve a dedicated Architect session transcript across service restarts while reading normal shared Pi state; persist its metadata with `archived_at` set.
- [x] Install the compiled `pi` binary and install, enable, start, and restart the user service through deployment.

## How it works

- [../wiki/systems/architect-service.md](../wiki/systems/architect-service.md)
- [bwrap-sandbox.md](bwrap-sandbox.md)

## Implementation inventory

- `packages/coding-agent/src/architect/observer.ts` — read-only, bounded, current-main-session control-DB snapshots and material-change detection.
- `packages/coding-agent/src/architect/prompt.ts` — advisor policy and structured observation prompt.
- `packages/coding-agent/src/architect/main.ts` — 30-second resident SDK process with the read-only bwrap profile and sandboxed Pyrun runner.
- `packages/coding-agent/systemd/pi-architect.service` — user-service template for the installed binary.
- `deploy.sh` — compiled binary installation and systemd unit deployment.

## Tests asserting this spec

- `packages/coding-agent/test/architect-observer.test.ts` — initial/material snapshots, completed-goal stability, current-main-session selection, deterministic metadata deduplication, subagent/self exclusion, and explicit main-session architect-request filtering.
- `packages/coding-agent/test/session-directory.test.ts` — regression proving Architect and global
  inventory retain only the current main-session binding.
- `packages/coding-agent/test/architect-service.test.ts` — Architect prompt policy, installed-binary unit command, and deployment reload, enable/start, and restart steps.

## Known gaps (current cycle)

- [x] `architect-observer.test.ts` covers initial/material snapshots, current-main-session selection, deterministic metadata deduplication, subagent/self exclusion, read-only missing-DB behavior, and self-message suppression.
- [x] `architect-service.test.ts` covers event-driven prompting, bounded shutdown, the read-only profile, global-fanout and broadcast blocking, and deployment lifecycle commands.
- [x] Deployment builds the compiled binary, installs/enables/restarts the service, and systemd health is verified.

## Out of scope

- Protecting credentials or other readable workspace data from the Architect itself. The Architect is trusted; bwrap limits autonomous mutation and remediation, not confidentiality.
- Sandboxing arbitrary host-side extension tools or hooks. Enabled extensions remain trusted host capabilities outside bwrap's selected worker routing.
- Discarding a pending Architect request solely because its sender exits before the next observer cycle. Requests remain in the dedicated SQLite queue until direct runtime-mailbox transport succeeds; expired claims return to pending.
- Task dispatch, autonomous code changes, process/session control, or automatic remediation.
- Reading full agent transcripts on routine observations.
- Pi bridge capabilities for sandboxed runtimes. They are deliberately disabled.
