# Headless Pi test fixture

[Contract](../../specs/headless-pi-test-fixture.md)

## Fixture boundary

Import `withHeadlessPi` from [`headless-pi.ts`](../../../packages/coding-agent/test/suite/headless-pi.ts). Its callback receives a real RPC Pi process plus provider/state observation helpers; callback success or failure triggers disposal. No real provider credentials are required for the default faux provider.

Path setup creates temporary agent, session and workspace directories and a private provider socket. The child receives isolated `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_STATE_DIR` (the same fixture agent directory), and session-directory overrides. Settings select approval/sandbox presets; default approval is auto-approve. The fixture requires Vitest's injected compile-cache root and worker ID.

[`RpcClient`](../../../packages/coding-agent/src/modes/rpc/rpc-client.ts) launches the production CLI with a Node preload and typed `send()` commands. [`headless-pi-provider-preload.ts`](../../../packages/coding-agent/test/suite/fixtures/headless-pi-provider-preload.ts) registers a faux provider, sends request IDs/context over Unix-socket JSONL, and waits for the test's correlated assistant response. Abort and socket closure reject pending responses. This private protocol does not add production RPC commands; see [RPC documentation](../../../packages/coding-agent/docs/rpc.md).

Event/request/UI buffers retain arrivals before a waiter starts and consume matching items. Store helpers inspect SQLite agents/mailboxes and claim/complete durable Supervisor requests. Buffered event/request/UI and agent/mailbox store waits default to 30 seconds and include child stderr in timeout diagnostics. Disposal aborts waiters, cleans shared sessions and primary resources, terminates detached runners, and aggregates failures. `restart()` resumes the fixture session; `startSharedSession()` starts peers sharing its state.

## Limits and spec drift

This is RPC/process proof, not terminal-key-routing proof. Child agents retain production in-process behavior, not one OS process per agent. `autoDetachTools` is fixture-only; `cliPath` permits test entrypoints such as [`loop-shutdown-race-cli.ts`](../../../packages/coding-agent/test/suite/fixtures/loop-shutdown-race-cli.ts).

The spec still marks provider/RPC startup cleanup and stderr timeout diagnostics incomplete. Source now catches startup failures through `cleanupHeadlessStartup` and includes stderr in buffered/store wait timeouts. Those are implemented paths, not newly verified acceptance claims. Full-history exposure is limited by SessionManager's active-slice reopen behavior.

## Test evidence

Inspected, not run: [`headless-pi.test.ts`](../../../packages/coding-agent/test/suite/headless-pi.test.ts) contains spawn, restart, steering, detached-tool and disposal scenarios; [`headless-supervisor-systems.test.ts`](../../../packages/coding-agent/test/suite/headless-supervisor-systems.test.ts) covers durable goal/approval flows; [`loop-extension-runtime.test.ts`](../../../packages/coding-agent/test/suite/loop-extension-runtime.test.ts) covers shutdown barriers and tick coalescing.

Additional inspected test locations: [`agent-session-registration-failure.test.ts`](../../../packages/coding-agent/test/agent-session-registration-failure.test.ts), [`orphaned-detached-reconciliation.test.ts`](../../../packages/coding-agent/test/orphaned-detached-reconciliation.test.ts), [`session-active-slice-restart.test.ts`](../../../packages/coding-agent/test/suite/regressions/session-active-slice-restart.test.ts), [`active-slice-load.test.ts`](../../../packages/coding-agent/test/session-manager/active-slice-load.test.ts), [`rpc-client-process-exit.test.ts`](../../../packages/coding-agent/test/rpc-client-process-exit.test.ts), [`interactive-mode-resume-continuation.test.ts`](../../../packages/coding-agent/test/interactive-mode-resume-continuation.test.ts), and [`agent-loop.test.ts`](../../../packages/agent-core/test/agent-loop.test.ts). Test existence is not evidence of a run here.
