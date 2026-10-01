# Approval system

Contract: [Approval system](../../specs/approval-system.md).

## Enforcement order

[`AgentSession._installAgentToolHooks`](../../../packages/coding-agent/src/core/agent-session.ts) installs the execution boundary. Unconditional extension tool gates run first, including for tools that opt out of approval. `approvalRequired` defaults to true; false skips generic approval reviewers rather than bypassing hard gates.

[`policy.ts`](../../../packages/coding-agent/src/core/permissions/policy.ts) distinguishes `on-request`, `never`, and `auto-approve`. `never` blocks approval-required calls without invoking approval reviewers. Auto-approve first lets registered approval reviewers rewrite input or deny, then skips ordinary human/Supervisor review. It is not permission to bypass unconditional gates.

For on-request, [`orchestrator.ts`](../../../packages/coding-agent/src/core/permissions/orchestrator.ts) asks the hook/rule reviewer first. An explicit allow or block ends review; undefined falls through. Human presets use the native reviewer. LLM presets submit bounded current-request evidence (tool/input/call ID, request and active goal) to the resident Supervisor with a 30-second timeout, not a historical transcript.

[`approval-reviewer.ts`](../../../packages/coding-agent/src/supervisor/approval-reviewer.ts) maps typed approve/reject/error responses. Deny presets block rejection; ask presets escalate rejection to human review. Errors/invalid responses escalate where human review exists, otherwise block. [`client.ts`](../../../packages/coding-agent/src/supervisor/client.ts) supplies durable request/response transport.

## Controls and boundaries

[`presets.ts`](../../../packages/coding-agent/src/core/permissions/presets.ts) defines five user-facing presets and separate sandbox profiles. [`approval-controls`](../../../packages/coding-agent/extensions/approval-controls/src/index.ts) opens `/approvals` and `/sandbox` selectors; sandbox also accepts explicit profile/scope arguments. [`settings-manager.ts`](../../../packages/coding-agent/src/core/settings-manager.ts) stores scoped selections and derives policy. Only auto-approve maps to hook `bypassPermissions`.

A sandbox profile is not itself an OS isolation mechanism. Approval opt-out tools must enforce their own host-effect boundaries. Source is authoritative where installed extension API prose describes older hook semantics.

## Evidence

Tests inspected, not run: [policy](../../../packages/coding-agent/test/approval-policy.test.ts), [orchestrator](../../../packages/coding-agent/test/approval-orchestrator.test.ts), [settings](../../../packages/coding-agent/test/settings-manager.test.ts), [selectors](../../../packages/coding-agent/test/approval-selector.test.ts), and [session integration](../../../packages/coding-agent/test/suite/agent-session-model-extension.test.ts). [Supervisor reviewer](../../../packages/coding-agent/test/supervisor-approval-reviewer.test.ts) and [headless Supervisor systems](../../../packages/coding-agent/test/suite/headless-supervisor-systems.test.ts) cover decision/escalation behavior. No missing core policy mechanism identified in inspected paths.
