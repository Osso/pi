# Resident Architect Service

The resident Architect is a systemd-supervised Sol advisor that maintains cross-session context and posts evidence-backed coordination advice. It is not a dispatcher or remediation agent. Implementation details live in `docs/wiki/systems/architect-service.md` when needed.

## What it must do

### Observation

- [x] Poll relevant Pi session and shared-channel state every 30 seconds without prompting the model on unchanged state.
- [x] Prompt Sol on the initial session snapshot, material session/goal changes, or an explicit main-session channel message mentioning `architect`.
- [x] Ignore subagent channel posts as architect requests.
- [ ] Read observer state from SQLite without applying writer-oriented database configuration.

### Advice

- [ ] Keep normal Pi tools available while readonly bwrap isolates file/Pyrun/bash workers.
- [ ] Post only evidence-backed drift, conflict, or blocker advice through `channel_post`.
- [ ] Never dispatch agents, edit files, restart sessions, or remediate autonomously.

### Service lifecycle

- [ ] Run as a systemd user service using `openai-codex/gpt-5.6-sol`.
- [ ] Preserve a dedicated architect session transcript across restarts while using normal shared Pi state.
- [ ] Install, enable, start, and verify the service through deployment.

## How it works

- `docs/wiki/systems/architect-service.md`

## Implementation inventory

- `packages/coding-agent/src/architect/observer.ts` — structured material-change observer.
- `packages/coding-agent/src/architect/prompt.ts` — advisor policy and observation prompt.
- `packages/coding-agent/src/architect/main.ts` — resident SDK process.
- `packages/coding-agent/systemd/pi-architect.service` — user service template.

## Tests asserting this spec

- `packages/coding-agent/test/architect-observer.test.ts`

## Known gaps (current cycle)

- [ ] Add read-only observer DB access.
- [ ] Add service lifecycle tests and deploy installation.
- [ ] Deploy and prove the running systemd service emits only event-driven prompts.

## Out of scope

- Task dispatch, autonomous code changes, process/session control, or automatic remediation.
- Reading full agent transcripts on routine observations.
