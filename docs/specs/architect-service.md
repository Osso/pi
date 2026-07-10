# Resident Architect Service

Module boundary: core resident SDK service.

The resident Architect is a systemd-supervised Sol advisor that preserves a dedicated cross-session transcript and sends evidence-backed coordination advice only to the affected session. It is not a dispatcher or remediation agent. Implementation details live in [../wiki/systems/architect-service.md](../wiki/systems/architect-service.md).

## What it must do

### Observation

- [x] Poll a bounded snapshot containing only the most recently registered non-subagent main session for each freshly live Pi process, deduplicated by session identity and excluding the Architect itself, every 30 seconds without prompting the model when state is unchanged.
- [x] Prompt on the initial session snapshot, material session/goal changes, or a new main-session shared-channel request beginning `Architect:`.
- [x] Ignore subagent and Architect-originated channel posts as architect requests.
- [x] Open observer state through SQLite read-only access without applying writer-oriented database configuration.

### Advice

- [x] Keep the standard Pi tool set available while the `read-only` bwrap profile routes file and shell workers through Bubblewrap; `pyrun_eval` is blocked rather than sandboxed.
- [x] Send only evidence-backed drift, conflict, or blocker advice to the affected session through targeted `broadcast`; block global `channel_post` fanout.
- [x] Never dispatch agents, edit files, restart sessions, or remediate autonomously.

### Service lifecycle

- [x] Run `~/.local/bin/pi architect` as a systemd user service using `openai-codex/gpt-5.6-sol`.
- [x] Preserve a dedicated Architect session transcript across service restarts while reading normal shared Pi state.
- [x] Install the compiled `pi` binary and install, enable, start, and restart the user service through deployment.

## How it works

- [../wiki/systems/architect-service.md](../wiki/systems/architect-service.md)
- [bwrap-sandbox.md](bwrap-sandbox.md)

## Implementation inventory

- `packages/coding-agent/src/architect/observer.ts` — read-only, bounded, current-main-session control-DB snapshots and material-change detection.
- `packages/coding-agent/src/architect/prompt.ts` — advisor policy and structured observation prompt.
- `packages/coding-agent/src/architect/main.ts` — 30-second resident SDK process with the read-only bwrap profile.
- `packages/coding-agent/systemd/pi-architect.service` — user-service template for the installed binary.
- `deploy.sh` — compiled binary installation and systemd unit deployment.

## Tests asserting this spec

- `packages/coding-agent/test/architect-observer.test.ts` — initial/material snapshots, current-main-session selection, deterministic metadata deduplication, subagent/self exclusion, and explicit main-session architect-request filtering.
- `packages/coding-agent/test/architect-service.test.ts` — installed-binary unit command plus deployment reload, enable/start, and restart steps.

## Known gaps (current cycle)

- [x] `architect-observer.test.ts` covers initial/material snapshots, current-main-session selection, deterministic metadata deduplication, subagent/self exclusion, read-only missing-DB behavior, and self-message suppression.
- [x] `architect-service.test.ts` covers event-driven prompting, bounded shutdown, the read-only profile, global-fanout blocking, and deployment lifecycle commands.
- [x] Deployment builds the compiled binary, installs/enables/restarts the service, and systemd health is verified.

## Out of scope

- Task dispatch, autonomous code changes, process/session control, or automatic remediation.
- Reading full agent transcripts on routine observations.
- Sandboxed Pyrun execution; bwrap currently blocks `pyrun_eval` under sandbox-required profiles.
