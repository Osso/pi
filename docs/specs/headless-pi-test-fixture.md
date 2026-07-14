# Headless Pi test fixture

Module boundary: coding-agent integration-test utility built on the production RPC process boundary.

The headless Pi test fixture starts a real `pi --mode rpc` child process with isolated configuration, sessions, control database, workspace, and a test-controlled faux provider. It exists to test production session, extension, multi-agent, mailbox, and shutdown behavior without a terminal UI.

## What it must do

### Process lifecycle

- [x] Start a real RPC-mode Pi process for each fixture invocation.
- [x] Give each process isolated agent, session, control-database, and workspace paths.
- [x] Terminate the process when the test succeeds or fails, including children that ignore `SIGTERM`.
- [x] Remove partial fixture files when path creation fails.
- [ ] Remove fixture files when provider or RPC client startup fails.
- [x] Remove all fixture files when the test body succeeds or fails.

### Control API

- [x] Accept typed RPC commands through `agent.send({...})`.
- [x] Wait for production RPC events without racing events emitted before the waiter starts.
- [x] Expose provider requests and allow the test to supply a response to a specific request.
- [x] Wait deterministically for persisted agents and mailbox messages.
- [x] Reject pending event, provider-request, agent, and mailbox waiters when the fixture disposes.
- [x] Reject new event, provider-request, agent, and mailbox waiters immediately after disposal.
- [ ] Include child-process stderr in bounded timeout diagnostics.

### Multi-agent behavior

- [x] Exercise the production `spawn_agent` tool path.
- [x] Expose the child user instruction received by the faux provider.
- [x] Observe a completed child's notification after delivery to the main-thread mailbox.
- [x] Prove interrupting an active real-process turn preserves queued steering and submits it in the replacement LLM request.

## How it works

- Detached-tool scenarios enable the fixture-only `autoDetachTools` option, which gives the child process a short headless auto-detach interval without changing the production default.
- [RPC protocol](../../packages/coding-agent/docs/rpc.md)
- [Multi-agent contract](multi-agent.md)

## Implementation inventory

- `packages/coding-agent/test/suite/headless-pi.ts` — disposable parent-side fixture and assertion helpers.
- `packages/coding-agent/test/suite/fixtures/headless-pi-provider-preload.ts` — child-process faux provider connected through private Unix-socket JSONL.
- `packages/coding-agent/src/modes/rpc/rpc-client.ts` — typed RPC transport with configurable Node startup arguments and public raw command sending.
- `packages/coding-agent/src/modes/index.ts` — mode-level `RpcCommandBody` type export.
- `packages/coding-agent/src/index.ts` — package-level `RpcCommandBody` type export.
- `packages/coding-agent/docs/rpc.md` — public `RpcClient.send()` and preload configuration documentation.

## Tests asserting this spec

- `packages/agent-core/test/agent-loop.test.ts`
- `packages/coding-agent/test/interactive-mode-resume-continuation.test.ts`
- `packages/coding-agent/test/suite/headless-pi.test.ts`
- `packages/coding-agent/test/rpc-client-process-exit.test.ts`

## Session restoration (current cycle)

Recovery is reconstructed from the existing session JSONL. It does not add recovery records, replay markers, execution rows, attempt rows, or a replay limit.

- [x] Prove a gracefully terminated post-tool thinking turn automatically issues a replacement LLM request after session restore and completes (`headless-pi.test.ts`: `continues post-tool model thinking after restoring the session JSONL`).
- [x] Prove restoring JSONL that ends with an unfinished Bash or Pyrun tool call reattaches its still-running durable runner without executing the command again (`headless-pi.test.ts`: `reattaches a live Bash runner when restoring its unfinished JSONL tool call`; `reattaches a live Pyrun runner when restoring its unfinished JSONL tool call`).
- [x] Prove restoring the same unfinished JSONL tool call reruns the Bash or Pyrun command when its original runner cannot be reattached (`headless-pi.test.ts`: `reruns an unfinished Bash JSONL tool call when its original runner is dead`; `reruns an unfinished Pyrun JSONL tool call when its original runner is dead`).
- [x] Prove restoring after a failed Bash or Pyrun result continues model thinking without running the command again (`headless-pi.test.ts`: `does not rerun a failed Bash tool when restoring its session`; `does not rerun a failed Pyrun tool when restoring its session`).
- [x] Prove restoring a session whose Bash or Pyrun job was interrupted while cancelling settles the existing job without running the command again (`headless-pi.test.ts`: `does not resume a cancelling Bash tool when restoring its session`; `does not resume a cancelling Pyrun tool when restoring its session`).
- Restoring later repeats the same reattach-or-rerun rule; no recovery-specific retry state is persisted.

## Detached tool completion (current cycle)

- [x] Prove the caller JSONL first persists the detached `toolResult` with `backgroundJobId`, then persists one `detached_tool_call_completion` entry with the same `toolCallId` after terminal completion (`headless-pi.test.ts`: `persists detached tool state and terminal completion in the caller JSONL`).
- [x] Prove a detached tool started by a nested subagent sends its terminal completion only to that subagent's direct parent agent and does not notify the main thread (`headless-pi.test.ts`: `routes a subagent detached completion only to the detached job parent`).

## Out of scope

- Replacing unit tests that intentionally exercise one isolated store or repository transaction.
- Adding test-control commands to the production RPC wire protocol.
- Running child agents as separate operating-system processes; the fixture preserves current production child-session behavior.
