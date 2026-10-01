# Resume session as agent

[Contract](../../specs/resume-session-as-agent.md). Unlike [resume_session](resume-session-tool.md), attachment does not replace the supervisor.

## Attachment and execution

[Agents-core runtime](../../../packages/coding-agent/extensions/agents-core/src/runtime.ts) registers `attach_session_agent`. It accepts exactly one of `path`, `sessionId`, or `name`; ID lookup prefers exact identity before an unambiguous prefix, and name matching is exact. Explicit paths are opened through [SessionManager](../../../packages/coding-agent/src/core/session-manager.ts); directory listings resolve other selectors.

`spawnAttachedSessionAgent` calls the lifecycle coordinator's attachment constructor with transcript path and preserved session ID, allocating a separate agent ID. [MultiAgentStore](../../../packages/coding-agent/src/core/multi-agent-store.ts) publishes the resulting snapshot under the supervisor's persisted store. Attachment without a prompt returns a dormant `waiting_for_input` record; it does not open an executing child runtime.

With a prompt, `dispatchAttachedSessionAgent` acquires runtime ownership before dispatch. `createProductionAttachedSessionFactory` opens the existing transcript, checks its expected session ID and cwd, then creates a normal child AgentSession with explicit agent ID, parent-session identity, shared store, and child tool exclusions. [main.ts](../../../packages/coding-agent/src/main.ts) supplies this production factory; [agents-core exports](../../../packages/coding-agent/extensions/agents-core/src/index.ts) expose it to callers. The transcript is opened, not forked into a new durable session identity.

Normal child dispatch handles completion, failure, abort, and notifications. Mailbox addressing combines preserved session identity with the new agent identity. Recovery examines persisted in-flight records and ownership; a transcript or old handle is not evidence that a runtime is alive. Already-waiting attachments are not automatically prompted.

## Limits and unimplemented protection

Dormant attachments have no runtime lease. Current tests explicitly show steering failing and `close_agent` returning `runtime ownership unavailable`; plain mailbox messages can remain queued. Listing/viewing a dormant record is not execution.

`buildAttachedSessionPermission` records inherited/narrowed policy metadata, defaulting root attachments to `on-request`. The production factory selects configured profile/model and ordinary child tools, but this metadata alone is not proof of enforced permission narrowing. Attachment-specific prevention of project-trust, approval, or filesystem-permission bypass remains unimplemented/unverified as marked in the contract. The factory does not itself provide a complete supervisor-to-child security-policy transfer. Do not infer that guarantee from preserved identity or standard lifecycle reuse.

## Test evidence

Tests inspected, not run: [multi-agent-extension.test.ts](../../../packages/coding-agent/test/multi-agent-extension.test.ts) asserts preserved session identity, distinct agent ID, dormant limitations, prompted cancellation, completion mailbox routing, recovery, and missing/mismatched transcript errors. [Store tests](../../../packages/coding-agent/test/multi-agent-store.test.ts) and [runtime-mailbox tests](../../../packages/coding-agent/test/runtime-mailbox.test.ts) cover persistence and transport boundaries; they are not proof of the outstanding trust guarantee.
