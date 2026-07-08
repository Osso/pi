# Approval System

Module boundary: core policy/enforcement subsystem plus first-party `approval-controls` extension module for `/approvals` and `/sandbox`.

The approval system controls when Pi asks before running tools, who reviews
those requests, and how no-prompt modes behave. The baseline reviewer today is
the native `tool_call` extension hook (`pi.on("tool_call", handler)` in
`packages/coding-agent/src/core/agent-session.ts:414–462`). This spec adds a
policy preset layer and two slash commands on top of that existing baseline;
it does not replace the hook. Slash-command registration lives in the
`packages/coding-agent/extensions/approval-controls/` first-party extension.
Policy state, preset logic, and policy gating live in
`packages/coding-agent/src/core/permissions/`.
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
- [x] Keep `never` and `auto-approve` distinct in CLI parsing and UI surfaces.
- [x] Map a future `--dangerously-bypass-approvals` flag to `auto-approve`, not
  to `never`.

### Approval reviewers

- [x] Support human-reviewed approvals for `on-request` via the native
  `tool_call` hook and `ui.confirm`.
- [x] Support LLM-approved approvals as `on-request` with the reviewer set to
  the auto-reviewer path (a permissive guardian LLM call that pre-approves
  ordinary bounded-risk coding-agent work). `LLM Approved (and deny)` denies
  catastrophic, credential-exposing, irreversible data-loss, system-damaging,
  or unrelated external-side-effect actions; `LLM Approved (and ask)` escalates
  those cases to the human reviewer.
- [x] Expose LLM-approved deny and LLM-approved ask modes as explicit choices
  in the `/approvals` preset selector, distinct from `never` and `auto-approve`.
- [x] Skip the LLM-approved reviewer when the action has already been approved
  by a hook (`tool_call` handler returned no block), a cached rule, or an
  explicit policy decision — hook `allow` short-circuits both human and LLM
  review.
- [x] Do not run the LLM-approved reviewer when the active policy is `never` or
  `auto-approve`.
- [x] Tools can opt out of generic wrapper approval with `approvalRequired:
  false` only when they gate their own host effects internally; those calls skip
  hook, human, and LLM reviewers at the wrapper layer.
- [x] Include the last 30 LLM approval decisions from the current session in
  future LLM approval prompts to improve consistency within the same session.
- [x] Load structured persistent approval memory from
  `~/.config/pi/agent/approval-memory.jsonl` into LLM approval prompts.
- [x] Allow the LLM approval reviewer to suggest structured persistent memory
  records; Pi validates bounded fields before appending them to the JSONL file.

### Presets and slash commands

- [x] Register `/approvals` as a slash command that opens an approval preset
  selector; choices must include at least: Ask Me (on-request/human),
  LLM Approved (and deny) (on-request/auto-reviewer), LLM Approved (and ask)
  (on-request/auto-reviewer with human escalation), Never Ask/Deny (never), and
  Auto Approve (auto-approve).
- [x] Register `/sandbox` as a slash command that opens a sandbox/profile
  selector without changing approval policy; choices must include at least:
  Read Only (where supported by the external container), Default/Workspace
  Write, and Full Access.
- [x] Do not present `/sandbox` choices as approval modes; approval behavior and
  sandbox access are separate concerns.
- [x] Persist the selected approval preset to `.pi/settings.json` (project) or
  `~/.config/pi/agent/settings.json` (global) when the user saves from the selector.
- [x] Migrate legacy persisted `llm-approved` preset values to
  `llm-approved-deny` to preserve existing autonomous-deny behavior.

### Hook compatibility

- [x] Preserve the native `tool_call` hook as the baseline rule/preclassification
  engine: a handler may return `{block: true, reason}` to deny, mutate
  `event.input` in place to rewrite args, or return nothing to allow.
- [x] Treat a `tool_call` handler that returns no block as an allow decision;
  do not re-prompt the human or run the LLM-approved reviewer after an implicit
  hook allow.
- [x] Never map Pi `never` policy to Claude Code `bypassPermissions` in hook
  compatibility payloads.
- [x] Allow Pi `auto-approve` policy to map to `bypassPermissions` in hook
	  compatibility payloads when Pi operates as a hook host.
- [x] Under `auto-approve`, still run registered approval reviewers far enough to
	  apply `updatedInput` rewrites or deny the call before execution; do not fall
	  through to native human approval or the LLM reviewer.

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
- `packages/coding-agent/src/core/permissions/presets.ts` — approval preset and
  sandbox profile metadata used by command selectors.
- `packages/coding-agent/src/core/settings-manager.ts` — approval policy settings
  read/write helpers, including `approvalPreset` identity plus derived
  `approvalPolicy`, and scoped sandbox profile serialization.
- `packages/coding-agent/src/core/permissions/auto-reviewer.ts` — LLM-approved
  reviewer: builds guardian prompt, calls the model, interprets the result as
  allow/deny or allow/ask depending on the selected preset. The prompt explicitly
  allows bounded local coding work and temporary workspace/cache cleanup such as
  deleting files under `/tmp`, and includes current-session approval history plus
  persistent approval memory.
- `packages/coding-agent/src/core/permissions/orchestrator.ts` — central
  approval flow: check policy and route `on-request` calls to the configured
  reviewer.
- `packages/coding-agent/src/core/permissions/approval-memory.ts` — validates,
  loads, and appends structured persistent approval memory records in
  `approval-memory.jsonl` under the active agent config directory.
- `packages/coding-agent/extensions/approval-controls/src/index.ts` — registers
  `/approvals` and `/sandbox` commands.
- `packages/coding-agent/src/core/extensions/types.ts` and
  `packages/coding-agent/src/core/extensions/runner.ts` — expose command-context
  actions used by the controls extension to open the interactive selectors.
- `packages/coding-agent/src/core/agent-session.ts` — thread active policy into
  `_installAgentToolHooks` so the orchestrator wraps permission prompt and
  `tool_call` review.

## Tests asserting this spec

- `packages/coding-agent/test/approval-policy.test.ts` — pure policy behavior for
  `on-request`, `never`, and `auto-approve`, including non-approval-required
  actions.
- `packages/coding-agent/test/settings-manager.test.ts` — approval policy default,
  project-over-global settings merge, distinct persisted values for `never` and
  `auto-approve`, scoped approval preset serialization, and sandbox profile
  serialization.
- `packages/coding-agent/test/approval-orchestrator.test.ts` — orchestrator
  policy gating for `on-request`, `never`, and `auto-approve`, plus hook
  reviewer short-circuit behavior before the future LLM reviewer.
- `packages/coding-agent/test/suite/agent-session-model-extension.test.ts` —
  session-level coverage proving `never` blocks before hook reviewers,
  `auto-approve` skips human/LLM review while preserving approval-reviewer
  `updatedInput`, and internally gated tools skip generic wrapper approval while
  ordinary tools still prompt.
- `packages/coding-agent/test/approval-slash-commands.test.ts` — built-in
  `/approvals` and `/sandbox` command metadata plus approval/sandbox separation.
- `packages/coding-agent/test/approval-auto-reviewer.test.ts` — LLM-approved
  reviewer prompt contract, result parser, session-history prompt context, and
  memory suggestion callbacks.
- `packages/coding-agent/test/approval-memory.test.ts` — persistent approval
  memory validation and JSONL load/append behavior.
- `packages/coding-agent/test/approval-selector.test.ts` — red tests for
  `/approvals` and `/sandbox` selector rendering and selection behavior.

## Known gaps (current cycle)

- [x] Define `ApprovalPolicy` type and config read/write in `policy.ts`.
- [x] Implement approval orchestrator with policy-gating and hook-shortcircuit
  logic.
- [x] Implement LLM-approved auto-reviewer.
- [x] Register `/approvals` command with preset selector UI.
- [x] Register `/sandbox` command with profile selector UI.
- [x] Wire orchestrator into `agent-session.ts` `beforeToolCall`.
- [x] Add tests for `on-request`/`never`/`auto-approve` core behavior.
- [x] Add tests proving hook-approved actions skip LLM-approved reviewer.
- [x] Add tests for `/approvals` command registration and preset serialization.
- [x] Add tests for `/approvals` and `/sandbox` command metadata before wiring UI
  selectors.
- [x] Add tests for scoped sandbox profile serialization without changing
  approval policy.
- [x] Add selector UI tests for `/approvals` and `/sandbox`.
- [x] Add failing tests for LLM-approved auto-reviewer prompt/result parsing.
- [x] Add tests for current-session approval history and persistent approval
  memory in LLM approval prompts.

## Out of scope

- Replacing the `tool_call` hook rule engine with Pi-native rule matching.
- Pi-native sandboxing; containerization is external (Gondolin, Docker,
  OpenShell) and the `/sandbox` selector chooses an external profile only.
- Changing any internal reviewer/guardian subsystem name; this spec only
  requires the user-facing preset labels to be clear and distinct.
