# Permission-prompt tool

[Contract](../../specs/permission-prompt-tool.md) · [Approval contract](../../specs/approval-system.md)

## Configuration and dispatch

`--permission-prompt-tool mcp__server__tool` is parsed by [`args.ts`](../../../packages/coding-agent/src/cli/args.ts), threaded by [`main.ts`](../../../packages/coding-agent/src/main.ts), and snapshots ahead of `settings.permissionPromptTool` in [`agent-session.ts`](../../../packages/coding-agent/src/core/agent-session.ts). Without an explicit name, a single loaded protocol-compatible MCP tool is selected; zero/ambiguous candidates yield no MCP reviewer.

Actual ordering is tool gates → approval-policy evaluation → registered approval reviewers → MCP permission handler → ordinary `tool_call` handlers → remaining LLM/human approval. Policy shortcuts can skip hook review. [`orchestrator.ts`](../../../packages/coding-agent/src/core/permissions/orchestrator.ts) distinguishes an explicit decision from `undefined`, which continues review.

[`mcp-permission-prompt.ts`](../../../packages/coding-agent/src/core/permissions/mcp-permission-prompt.ts) sends `{tool_name,input,tool_use_id,cwd}`, cloning input. It accepts an object, JSON string, or MCP text containing JSON. Deny returns `{block:true,reason}`; allow applies permission updates and replaces input in place. Invalid names/output and call exceptions return `undefined`.

[`rule-store.ts`](../../../packages/coding-agent/src/core/permissions/rule-store.ts) matches exact tool/rule content: Bash uses command text, others serialized input. Session allow updates populate memory. Other destinations write `permissionRules.allow` into agent `settings.json`, project `.pi/settings.json` or `.pi/settings.local.json`, preserving surrounding formatting. Non-session updates do not immediately populate that memory cache.

## Limits and unimplemented requirements

MCP allow and fallback both return `undefined`; allow is not an explicit orchestration decision. Consequently the contract's unconditional “allow without further prompting” guarantee is not implemented when subsequent human/LLM review is active. Matching rules skip the MCP call, not all downstream reviewers. No timeout is imposed by this handler itself.

Registered [`claude-bash-hook`](../../../packages/coding-agent/extensions/claude-bash-hook/src/index.ts) review precedes MCP, rather than being restricted to MCP absence. Its allow/ask/deny path also supports Pyrun. Native human approval currently uses `ui.select` (allow once/always/deny), not the spec's `ui.confirm` wording.

Rule writers support local-settings output, but [`settings-manager.ts`](../../../packages/coding-agent/src/core/settings-manager.ts) reads global/project `settings.json`, not `settings.local.json`; cross-session suppression from that destination is not established. Parser permission updates support only allow/addRules; deny responses do not apply updates. The spec records an external hook-server deny-to-allow compatibility issue; this checkout inspection does not verify that server's current behavior or real elicitation acceptance.

## Test evidence

Inspected, not run: [`mcp-permission-prompt.test.ts`](../../../packages/coding-agent/test/mcp-permission-prompt.test.ts) (stub decisions, rewrites, fallthrough, notification and cache behavior), [`permission-rule-store.test.ts`](../../../packages/coding-agent/test/permission-rule-store.test.ts) (exact rules and destination writers), [`args.test.ts`](../../../packages/coding-agent/test/args.test.ts), [`settings-manager.test.ts`](../../../packages/coding-agent/test/settings-manager.test.ts), and [`agent-session-model-extension.test.ts`](../../../packages/coding-agent/test/suite/agent-session-model-extension.test.ts) (stub MCP dispatch/discovery, persisted rules and local-hook review). Stub acceptance is not real MCP-server verification.
