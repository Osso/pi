# Goal System (`/goal`)

The goal system establishes a persistent, **evidence-gated acceptance contract** for the
current branch/session. A goal is more than a task list: it is a set of acceptance criteria
that must each be backed by *authoritative current evidence* before the agent may declare the
work complete. It encodes the "deploy a change safely" workflow — relevant tests, lint/type
gates, measurable coverage, deploy health, post-deploy smoke checks, and Sentry regression
checks — as machine-trackable gates rather than as prose the model can rationalize away.

It is the richer sibling of [`run-plan-command.md`](run-plan-command.md): `/run-plan` walks a
checklist and submits items; `/goal` defines *what done means* and refuses to call work done
until each criterion has fresh proof.

Source will live in a Pi extension (planned, see inventory). How it works belongs in
`docs/wiki/systems/goal-system.md` (stub — not yet written).

## What it must do

### Goal lifecycle
- [ ] `/goal set <description>` establishes an active goal for the current working directory / branch and persists it across turns and session reloads.
- [ ] `/goal show` prints the active goal, its acceptance criteria, and per-criterion gate status (pending / passed / failed / unverified).
- [ ] `/goal clear` removes the active goal.
- [ ] At most one active goal exists per project at a time; setting a new goal while one is active requires explicit replacement (`/goal set` warns and replaces, or refuses until `/goal clear`).
- [ ] The active goal survives `session_start` with reason `resume`/`reload`/`fork` (restored from persisted state, not in-context history).

### Goal adaptation (anti-template)
- [ ] On `/goal set`, the goal is anchored to the branch's actual changes — the system gathers `git status`, the `origin/main..HEAD` (fallback `origin/master..HEAD`) diff stat, and changed files — and the acceptance criteria are written around what the branch really changes, not a copied template.
- [ ] A goal whose criteria do not reference the branch's actual changed surface is flagged as under-specified.

### Gates (acceptance criteria)
- [ ] Each goal carries a set of gates; the default gate set is: **tests**, **lint/type**, **coverage**, **deploy health**, **post-deploy smoke**, **Sentry regression**.
- [ ] Gates are configurable per project (a project may declare which gates apply and the command that satisfies each, e.g. via project settings or the goal definition).
- [ ] Each gate has a status and an *evidence pointer* (command output, commit hash, URL, or test name) — a gate cannot be marked passed without an evidence pointer.
- [ ] A gate transitions to `failed` (not silently skipped) when its driver is missing — e.g. coverage with no coverage driver available is a blocker, not a pass.

### Enforcement
- [ ] Before each agent turn, the active goal and current gate status are injected into the model context (via `before_agent_start`), so the agent is continuously reminded of the open contract.
- [ ] The system surfaces a clear "goal not complete: gates X, Y unverified" state and resists a completion claim while any required gate lacks current evidence.
- [ ] Deploy gates are ordered: local gates (tests, lint/type, coverage) must be green before a deploy gate may be attempted; post-deploy gates (smoke, Sentry) only after a deploy gate reports the target commit healthy.
- [ ] Evidence is treated as perishable: a gate marked passed before a subsequent code change is re-opened (invalidated) when the working tree changes in a way that affects it.

### UI
- [ ] The active goal and a compact gate-status summary are visible in the TUI (e.g. via `setFooter`/`setWidget`).
- [ ] Gate status updates are reflected live as gates pass/fail.

## How it works

- `docs/wiki/systems/goal-system.md` (stub — not yet written).
- Builds on the native context-injection contract — see [`prompt-context-hooks.md`](prompt-context-hooks.md).
- Builds on the native lifecycle events — see [`session-lifecycle-hooks.md`](session-lifecycle-hooks.md).
- Persisted via Pi's session `custom` entry type (extension state, not in model context) — see `packages/coding-agent/docs/session-format.md`.

## Implementation inventory

- `.pi/extensions/goal/index.ts` — (planned) extension entry: registers `/goal` command, subscribes lifecycle + `before_agent_start` events.
- `.pi/extensions/goal/goal-store.ts` — (planned) persist/restore the active goal and gate state via session `custom` entries keyed by project path.
- `.pi/extensions/goal/gates.ts` — (planned) gate definitions, default gate set, evidence model, and the missing-driver-is-failure rule.
- `.pi/extensions/goal/adapt.ts` — (planned) gather branch evidence (`git` diff/status) to anchor acceptance criteria to actual changes.
- `.pi/extensions/goal/ui.ts` — (planned) footer/widget rendering of goal + gate status.

## Tests asserting this spec

(none yet — feature unimplemented)

## Known gaps (current cycle)

- [ ] Decide persistence layer: session `custom` entry vs a project-local `.pi/goal.json` (the latter is more inspectable per the "transparent over opaque" preference).
- [ ] Define the project gate-config schema (which gates apply, command per gate, site/project for Sentry).
- [ ] Implement `/goal set|show|clear` command + completions.
- [ ] Implement gate evaluation + evidence capture (read full command output, not just exit codes).
- [ ] Implement `before_agent_start` context injection of goal + gate status.
- [ ] Implement evidence invalidation on relevant working-tree change.
- [ ] Implement TUI footer/widget surface.
- [ ] Write `docs/wiki/systems/goal-system.md`.
- [ ] Add tests asserting each `What it must do` bullet, then flip to `- [x]`.

## Out of scope

- Actually performing deploys / mutating production — the goal system orchestrates and verifies gates; it does not own deploy mechanics (those remain the repo's `deploy.sh` / wait scripts).
- Multi-goal stacks or cross-project goals — one active goal per project for now.
- Automatic remediation — the system reports failed gates; it does not auto-fix them.
