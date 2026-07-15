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
- [x] Support LLM-approved approvals as `on-request` by sending a synchronous
  `approval_review` request to the resident Supervisor service. `LLM Approved
  (and deny)` blocks Supervisor rejection; `LLM Approved (and ask)` escalates
  Supervisor rejection to the human reviewer.
- [x] Expose LLM-approved deny and LLM-approved ask modes as explicit choices
  in the `/approvals` preset selector, distinct from `never` and `auto-approve`.
- [x] Skip the LLM-approved reviewer when the action has already been explicitly
  approved by a hook (`tool_call` handler returned `{ block: false }`), a cached
  rule, or an explicit policy decision. A hook returning `undefined` made no
  decision and must fall through to the configured Supervisor or human reviewer.
- [x] Do not run the LLM-approved reviewer when the active policy is `never` or
  `auto-approve`.
- [x] Tools can opt out of generic wrapper approval with `approvalRequired:
  false` only when they gate their own host effects internally; those calls skip
  hook, human, and LLM reviewers at the wrapper layer.
- [x] Send bounded current-request evidence to the Supervisor without historical
  session transcripts or the retired in-process approval decision history.
- [x] Escalate Supervisor `error`, timeout, unavailable-service, and invalid-response
  outcomes to the human reviewer.
- [x] Keep project approval memory in Supervisor-managed KB files rather than
  `approval-memory.jsonl` or an in-process reviewer prompt.

### Presets and slash commands

- [x] Register `/approvals` as a slash command that opens an approval preset
  selector; choices must include at least: Ask Me (on-request/human),
  LLM Approved (and deny) (on-request/Supervisor), LLM Approved (and ask)
  (on-request/Supervisor with human escalation), Never Ask/Deny (never), and
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
  engine: a handler may return `{ block: true, reason }` to deny, return
  `{ block: false }` to explicitly allow, mutate `event.input` in place to
  rewrite args, or return `undefined` when it makes no approval decision.
- [x] Treat `undefined` hook results as no decision and continue to the configured
  Supervisor or human reviewer; only explicit allow/block results short-circuit
  later reviewers.
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
  `approvalPolicy`, optional `approvalReviewerModel`, and scoped sandbox profile
  serialization.
- `packages/coding-agent/src/supervisor/approval-reviewer.ts` — converts typed
  Supervisor approval decisions into allow, reject, or human-escalation results.
- `packages/coding-agent/src/supervisor/client.ts` — persists bounded synchronous
  approval requests and waits for the resident service response.
- `packages/coding-agent/src/core/permissions/orchestrator.ts` — central
  approval flow: check policy and route `on-request` calls to the configured
  reviewer.
- `packages/coding-agent/extensions/approval-controls/src/index.ts` — registers
  `/approvals` and `/sandbox` commands.
- `packages/coding-agent/src/core/extensions/types.ts` and
  `packages/coding-agent/src/core/extensions/runner.ts` — expose command-context
  actions used by the controls extension and preserve explicit approval-reviewer
  allow decisions after applying input rewrites.
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
  policy gating for `on-request`, `never`, and `auto-approve`, including explicit
  hook decisions and undefined-hook fallthrough to the Supervisor reviewer.
- `packages/coding-agent/test/suite/agent-session-model-extension.test.ts` —
  session-level coverage proving `never` blocks before hook reviewers,
  `auto-approve` skips human/LLM review while preserving approval-reviewer
  `updatedInput`, and internally gated tools skip generic wrapper approval while
  ordinary tools still prompt.
- `packages/coding-agent/test/approval-slash-commands.test.ts` — built-in
  `/approvals` and `/sandbox` command metadata plus approval/sandbox separation.
- `packages/coding-agent/test/supervisor-approval-reviewer.test.ts` — typed
  approve/reject/error handling and human escalation.
- `packages/coding-agent/test/suite/agent-session-model-extension.test.ts` —
  session integration, bounded request evidence, preset escalation, and hook/rule
  short-circuit behavior.
- `packages/coding-agent/test/approval-selector.test.ts` — red tests for
  `/approvals` and `/sandbox` selector rendering and selection behavior.
- `packages/coding-agent/test/suite/headless-supervisor-systems.test.ts` — real
  RPC-process coverage for Supervisor approval execution, rejection, errors,
  human escalation, and deny-preset blocking.

## Known gaps (current cycle)

- [x] Define `ApprovalPolicy` type and config read/write in `policy.ts`.
- [x] Implement approval orchestrator with policy-gating and hook-shortcircuit
  logic.
- [x] Replace the LLM-approved auto-reviewer with resident Supervisor review.
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
- [x] Add tests for typed Supervisor approval decisions and human escalation.
- [x] Replace in-process approval history and `approval-memory.jsonl` with
  Supervisor-managed KB memory.

## Out of scope

- Replacing the `tool_call` hook rule engine with Pi-native rule matching.
- Pi-native sandboxing; containerization is external (Gondolin, Docker,
  OpenShell) and the `/sandbox` selector chooses an external profile only.
- Changing any internal reviewer/guardian subsystem name; this spec only
  requires the user-facing preset labels to be clear and distinct.
