# Resident Architect Service

Module boundary: core resident SDK service.

The resident Architect is a Linux systemd-managed Sol advisor with a dedicated cross-session transcript and evidence-backed advisory policy. Deployment installs, enables, restarts, and health-checks `pi-architect.service`; the built-in `ask_architect` tool remains disabled. Implementation details live in [../wiki/systems/architect-service.md](../wiki/systems/architect-service.md).

## What it must do

### Observation

- [x] Poll a bounded sessions snapshot already prefiltered to non-subagent main sessions with a
      current main listener and matching fresh `ok` health, one per live Pi process, deduplicated
      by session identity and excluding the Architect itself, every 30 seconds without prompting
      the model when state is unchanged. The model receives no raw listener or health fields.
      Historical same-PID sessions must not appear in either Architect or global session inventory.
- [x] Prompt on the initial session snapshot, material session/goal changes, or an atomically claimed request from the dedicated Architect request queue. Idle request polling probes for pending or stale-claimed work read-only without reserving the SQLite writer lock; stale-claim recovery, pending-row selection, and the bounded batch claim remain one immediate transaction. Claim renewal deduplicates request IDs, updates them set-wise, and validates all requested claims atomically: completed rows are accepted, while any missing or foreign claim rolls back the whole renewal.
- [x] Persist each new explicit request with its originating project context path. `ask_architect.project_path` selects an absolute project directory, such as the active worktree, when it differs from the session cwd; omission defaults to the session cwd. For project design or behavior questions, prompt policy must use the Architect-only spec reader to resolve the project root from that cwd, read authoritative `docs/specs/README.md` first, then read only the relevant Markdown feature spec instead of requiring copied spec text. Existing queued rows without cwd remain readable and must be reported as lacking project context rather than guessed.
- [x] Treat `goal_json.completedAt` as completed-goal state only, not session termination. The
      model uses membership in the prefiltered sessions snapshot, never goal fields, as its only
      liveness evidence.
- [x] Ignore subagent and Architect-originated channel posts as architect requests.
- [x] Open observer state through SQLite read-only access without applying writer-oriented database configuration.

### Resident console

- [x] `pi --architect` attaches to an already-running Architect through its owner-only local console socket; it never starts a second Architect, creates a second session owner, or changes the resident cwd.
- [x] Reject missing or unavailable Architect sockets explicitly, while preserving the positional `pi architect` service entrypoint.
- [x] Send the resident session identity, fixed cwd, generation, and complete current branch on attach, then stream live session events.
- [x] Accept interactive console prompts and an optional trailing initial prompt, with exactly one writable console client at a time; a new console attachment replaces and disconnects the previous client without replacing the resident session.
- [x] Serialize console prompts with observation and request prompts; console input remains subject to the Architect's existing advisory-only tool and rule boundaries.

### Advice

- [x] Load shared and `rules/architect/*.md` user rules through an explicit rule-scope override while retaining the Architect's `observer` execution role; ordinary observers remain shared-only.
- [x] Keep `ask_architect` out of the built-in tool registry and default active tool list; the Architect runtime excludes `broadcast`, `ask_architect`, and `contact_parent`.
- [x] Send evidence-backed advice through direct `send_agent_message` delivery to the originating session; block `broadcast` and global `channel_post` fanout.
- [x] Frame findings as advisory hypotheses for the receiving session to verify, accept, reject, or defer; never issue commands, execution gates, stop conditions, operational sequencing, mandatory next steps, or reinterpret goal completion.
- [x] Never dispatch agents, edit files, restart sessions, or remediate autonomously.

### Service lifecycle

- [x] Run the installed Bun-compiled Architect as the Linux `pi-architect.service` systemd user service using `openai-codex/gpt-5.6-sol`; deployment enables, restarts, and health-checks it.
- [x] Preserve a dedicated Architect session transcript across service restarts while reading normal shared Pi state; persist its metadata with `archived_at` set.
- [x] Install the compiled `pi` binary while default deployment keeps Architect systemd-managed and disables/removes only the Supervisor unit on Linux; Darwin skips systemd configuration and Supervisor uses Pi-managed lazy startup.

## How it works

- [../wiki/systems/architect-service.md](../wiki/systems/architect-service.md)
- [bwrap-sandbox.md](bwrap-sandbox.md)

## Implementation inventory

- `packages/coding-agent/src/core/tools/ask-architect.ts` — queues explicit requests with sender session and a validated absolute directory path, such as an active worktree.
- `packages/coding-agent/src/core/session-control-db.ts` — persists and migrates durable Architect requests.
- `packages/coding-agent/src/architect/observer.ts` — read-only, bounded, current-main-session control-DB snapshots and material-change detection.
- `packages/coding-agent/src/architect/prompt.ts` — advisor policy, authoritative-spec discovery, and structured observation prompt.
- `packages/coding-agent/src/architect/project-spec.ts` — Architect-only, canonical-path-constrained reader for Markdown files under the originating project's `docs/specs/` tree.
- `packages/coding-agent/src/architect/main.ts` — 30-second resident SDK process with the `architect` user-rule scope, observer execution role, read-only bwrap profile, sandboxed Pyrun runner, and resident console server.
- `packages/coding-agent/src/core/resident-console-transport.ts` — owner-only attach protocol, branch snapshot, live events, and single-client prompt transport.
- `packages/coding-agent/src/cli/resident-console-command.ts` — `--architect` console client and optional initial prompt handling.
- `packages/coding-agent/src/main.ts` — early dispatch for resident-console flags without changing service commands.
- `packages/coding-agent/systemd/pi-architect.service` — user-service template for the installed Bun-compiled Pi binary.
- `deploy.sh` — compiled binary installation and resident-service configuration.
- `scripts/configure-resident-services.sh` — direct one-argument systemd configuration for both resident services and deployment-mode Supervisor-only cleanup.

## Tests asserting this spec

- `packages/coding-agent/test/architect-observer.test.ts` — initial/material snapshots, completed-goal stability, current-main-session selection, deterministic metadata deduplication, subagent/self exclusion, and explicit main-session architect-request filtering.
- `packages/coding-agent/test/session-directory.test.ts` — regression proving Architect and global
  inventory retain only the current main-session binding.
- `packages/coding-agent/test/architect-service.test.ts` — Architect observer, policy, console, and shutdown behavior.
- `packages/coding-agent/test/deploy-resident-services.test.ts` — Architect systemd lifecycle, Supervisor-only autostart cleanup, explicit systemd mode, and Darwin skip.
- `packages/coding-agent/test/list-sessions-broadcast-tools.test.ts` — explicit directory persistence and canonicalization, cwd defaulting, and empty, relative, missing, or non-directory path rejection.
- `packages/coding-agent/test/session-control-db.test.ts` — durable request persistence, claims, completion, and project-cwd projection.
- `packages/coding-agent/test/architect-service.test.ts` — console wake, prompt serialization, exact branch snapshot, and lifecycle ownership.
- `packages/coding-agent/test/resident-console-command.test.ts` — resident-console flag parsing and positional-command preservation.
- `packages/coding-agent/test/resident-console-client.test.ts` — attach snapshot, prompt submission, live events, and unavailable-service errors.

## Known gaps (current cycle)

- [x] `architect-observer.test.ts` covers initial/material snapshots, current-main-session selection, deterministic metadata deduplication, subagent/self exclusion, read-only missing-DB behavior, and self-message suppression.
- [x] `architect-service.test.ts` covers event-driven prompting, bounded shutdown, the read-only profile, global-fanout and broadcast blocking, and deployment lifecycle commands.
- [x] Linux deployment keeps `pi-architect.service` enabled, restarted, and health-checked while default mode disables/removes only `pi-supervisor.service`; explicit systemd mode verifies Supervisor health.

## Out of scope

- Protecting credentials or other readable workspace data from the Architect itself. The Architect is trusted; bwrap limits autonomous mutation and remediation, not confidentiality.
- Sandboxing arbitrary host-side extension tools or hooks. Enabled extensions remain trusted host capabilities outside bwrap's selected worker routing.
- Discarding a pending Architect request solely because its sender exits before the next observer cycle. Requests remain in the dedicated SQLite queue until direct runtime-mailbox transport succeeds; expired claims return to pending.
- Task dispatch, autonomous code changes, process/session control, or automatic remediation.
- Reading full agent transcripts on routine observations.
- Pi bridge capabilities for sandboxed runtimes. They are deliberately disabled.
- Reworking or deleting the Architect implementation; this contract keeps its Linux systemd ownership while the `ask_architect` request tool remains disabled.
