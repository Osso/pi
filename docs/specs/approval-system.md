# Approval System

The approval system controls when Pi asks before running tools, who reviews
those requests, and how no-prompt modes behave. The baseline reviewer today is
the native `tool_call` extension hook (`pi.on("tool_call", handler)` in
`packages/coding-agent/src/core/agent-session.ts:414–462`). This spec adds a
policy preset layer and two slash commands on top of that existing baseline;
it does not replace the hook. Slash-command registration lives in
`packages/coding-agent/src/core/slash-commands.ts`. Policy state, preset logic,
and policy gating live in `packages/coding-agent/src/core/permissions/`.
Implementation details belong in
`docs/wiki/systems/approval-system.md` (stub — not yet written).

## What it must do

### Approval policies

- [x] Support normal ask mode as `on-request`: approval-required actions are
  routed to the configured reviewer (human or LLM).
- [x] Support no-prompt reject mode as `never`: approval-required actions are
  rejected and returned to the model without showing any reviewer.
- [x] Support no-prompt approve mode as `auto-approve`: approval-required
  actions are treated as approved without human or LLM review.
- [x] Keep `never` and `auto-approve` distinct in config and settings
  serialization — they must never collapse into the same value.
- [ ] Keep `never` and `auto-approve` distinct in CLI parsing and UI surfaces.
- [ ] Map a future `--dangerously-bypass-approvals` flag to `auto-approve`, not
  to `never`.

### Approval reviewers

- [ ] Support human-reviewed approvals for `on-request` via the native
  `tool_call` hook and `ui.confirm`.
- [ ] Support LLM-approved approvals as `on-request` with the reviewer set to
  the auto-reviewer path (a guardian LLM call that pre-approves the tool call).
- [ ] Expose LLM-approved mode as an explicit choice in the `/approvals` preset
  selector, distinct from `never` and `auto-approve`.
- [ ] Skip the LLM-approved reviewer when the action has already been approved
  by a hook (`tool_call` handler returned no block), a cached rule, or an
  explicit policy decision — hook `allow` short-circuits both human and LLM
  review.
- [x] Do not run the LLM-approved reviewer when the active policy is `never` or
  `auto-approve`.

### Presets and slash commands

- [ ] Register `/approvals` as a slash command that opens an approval preset
  selector; choices must include at least: Ask Me (on-request/human),
  LLM Approved (on-request/auto-reviewer), Never Ask/Deny (never), and
  Auto Approve (auto-approve).
- [ ] Register `/sandbox` as a slash command that opens a sandbox/profile
  selector without changing approval policy; choices must include at least:
  Read Only (where supported by the external container), Default/Workspace
  Write, and Full Access.
- [ ] Do not present `/sandbox` choices as approval modes; approval behavior and
  sandbox access are separate concerns.
- [ ] Persist the selected approval preset to `.pi/settings.json` (project) or
  `~/.pi/agent/settings.json` (global) when the user saves from the selector.

### Hook compatibility

- [ ] Preserve the native `tool_call` hook as the baseline rule/preclassification
  engine: a handler may return `{block: true, reason}` to deny, mutate
  `event.input` in place to rewrite args, or return nothing to allow.
- [ ] Treat a `tool_call` handler that returns no block as an allow decision;
  do not re-prompt the human or run the LLM-approved reviewer after an implicit
  hook allow.
- [ ] Never map Pi `never` policy to Claude Code `bypassPermissions` in hook
  compatibility payloads.
- [ ] Allow Pi `auto-approve` policy to map to `bypassPermissions` in hook
  compatibility payloads when Pi operates as a hook host.

## How it works

- `docs/wiki/systems/approval-system.md` (stub — not yet written).
- `docs/specs/permission-prompt-tool.md` — the MCP permission prompt tool that
  plugs into this policy layer as an external reviewer.

## Implementation inventory

- `packages/coding-agent/src/core/permissions/` — approval policy helpers and
  rule stores.
- `packages/coding-agent/src/core/permissions/policy.ts` — `ApprovalPolicy`
  type (`on-request` | `never` | `auto-approve`), active policy state,
  and preset behavior evaluation.
- `packages/coding-agent/src/core/settings-manager.ts` — approval policy settings
  read/write helpers. (partial; CLI/UI plumbing still planned)
- `packages/coding-agent/src/core/permissions/auto-reviewer.ts` — LLM-approved
  reviewer: builds guardian prompt, calls the model, interprets the result as
  allow/deny. (planned)
- `packages/coding-agent/src/core/permissions/orchestrator.ts` — central
  approval flow: check policy and route `on-request` calls to the configured
  reviewer. (partial; LLM reviewer routing still planned)
- `packages/coding-agent/src/core/slash-commands.ts` — register `/approvals`
  and `/sandbox` commands; render preset selectors. (planned additions to
  existing file)
- `packages/coding-agent/src/core/agent-session.ts` — thread active policy into
  `_installAgentToolHooks` so the orchestrator wraps permission prompt and
  `tool_call` review.

## Tests asserting this spec

- `packages/coding-agent/test/approval-policy.test.ts` — pure policy behavior for
  `on-request`, `never`, and `auto-approve`, including non-approval-required
  actions.
- `packages/coding-agent/test/settings-manager.test.ts` — approval policy default,
  project-over-global settings merge, and distinct persisted values for `never`
  and `auto-approve`.
- `packages/coding-agent/test/approval-orchestrator.test.ts` — orchestrator
  policy gating for `on-request`, `never`, and `auto-approve`.
- `packages/coding-agent/test/suite/agent-session-model-extension.test.ts` —
  session-level coverage proving `never` and `auto-approve` skip hook reviewers.

## Known gaps (current cycle)

- [x] Define `ApprovalPolicy` type and config read/write in `policy.ts`.
- [x] Implement approval orchestrator with policy-gating and hook-shortcircuit
  logic.
- [ ] Implement LLM-approved auto-reviewer.
- [ ] Register `/approvals` command with preset selector UI.
- [ ] Register `/sandbox` command with profile selector UI.
- [x] Wire orchestrator into `agent-session.ts` `beforeToolCall`.
- [x] Add tests for `on-request`/`never`/`auto-approve` core behavior.
- [ ] Add tests proving hook-approved actions skip LLM-approved reviewer.
- [ ] Add tests for `/approvals` command registration and preset serialization.

## Out of scope

- Replacing the `tool_call` hook rule engine with Pi-native rule matching.
- Pi-native sandboxing; containerization is external (Gondolin, Docker,
  OpenShell) and the `/sandbox` selector chooses an external profile only.
- Changing any internal reviewer/guardian subsystem name; this spec only
  requires the user-facing preset labels to be clear and distinct.
