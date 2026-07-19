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
- [x] Attempt every shared-session and primary fixture cleanup even when another cleanup fails, and aggregate cleanup failures.

### Control API

- [x] Accept typed RPC commands through `agent.send({...})`.
- [x] Wait for production RPC events without racing events emitted before the waiter starts.
- [x] Expose provider requests and allow the test to supply a response to a specific request.
- [x] Configure isolated approval presets through the fixture's persisted settings.
- [x] Claim and answer durable Supervisor requests without bypassing the production control-database boundary.
- [x] Seed and inspect persisted goal state for real-process goal extension scenarios.
- [x] Capture RPC extension UI requests so tests can distinguish human escalation from background status output.
- [x] Wait deterministically for persisted agents and mailbox messages.
- [x] Reject pending event, provider-request, agent, and mailbox waiters when the fixture disposes.
- [x] Reject new event, provider-request, agent, and mailbox waiters immediately after disposal.
- [x] Start additional real RPC sessions against the fixture's shared control/session state, either creating a new session or resuming a specified `sessionFile`.
- [x] Pause a shared session after runtime-listener registration and before `session_start` using a fixture-only release marker.
- [x] Verify runtime-listener registration failure aborts startup before `session_start` (`agent-session-registration-failure.test.ts`).
- [ ] Include child-process stderr in bounded timeout diagnostics.

### Multi-agent behavior

- [x] Exercise the production `spawn_agent` tool path.
- [x] Expose the child user instruction received by the faux provider.
- [x] Observe a completed child's notification after delivery to the main-thread mailbox.
- [x] Restart the real supervisor while a child is blocked in its first provider request; verify the
      persisted transcript path/session identity and original assignment survive recovery, then verify
      exactly one completion notification routes to the original parent.
- [x] Steer a restored child through the current main session after supervisor restart; verify the
      post-restart main-session `steer_agent` request reaches the restored child and appears in its next
      provider request (`headless-pi.test.ts`: `steers a restored child through the current main session after restart`).
- [x] Start concurrent real RPC peer sessions after the original supervisor crashes; verify startup refreshes
      current runtime bindings and globally settles a detached cancellation only when its exact dead runner identity
      matches the worker handle and no terminal outbox already exists, regardless of parent-session liveness. Two
      peers serialize to one terminal commit without reparenting or duplicate terminalization.
- [x] Prove a foreign startup settles an exact dead detached runner while same-session startup is paused, and cover
      active descendants, a pre-existing terminal outbox, an exact live/replacement owner, PID reuse, and
      worker-handle mismatch guards (`headless-pi.test.ts`, `orphaned-detached-reconciliation.test.ts`).
- [x] Prove an RPC `interrupt` command during an active real-process turn preserves queued steering and submits it in the replacement LLM request. This test starts below terminal/TUI input routing and does not prove that an Escape key reaches the interrupt command.
- [x] Prove steering accepted immediately after a real Pyrun tool turn reaches `agent_end` wakes the idle session and produces a new model request instead of remaining queued indefinitely (`headless-pi.test.ts`: `wakes idle steering after completion of a real Pyrun tool turn`).
- [x] Prove `wait_agents` remains blocked while an active child has pending `steer_agent` input, the steering reaches the child's next LLM request, and the wait returns only after that full child turn completes and terminalizes.

### Terminal interrupt coverage

- [x] Route raw Escape input through a real `TUI` and `VirtualTerminal` while another focused component can consume input.
- [x] Prove the global interrupt listener consumes Escape first, interrupts the active main turn, and preserves queued steering plus current editor text (`interactive-mode-status.test.ts`: `raw terminal escape interrupts before a focused component can consume it and preserves queued steering`).
- [x] Keep the RPC real-process test as the independent lower-layer proof that interruption creates a replacement LLM request containing queued steering (`headless-pi.test.ts`: `preserves queued steering when interrupting an active turn`).

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
- `packages/coding-agent/test/agent-session-registration-failure.test.ts`
- `packages/coding-agent/test/orphaned-detached-reconciliation.test.ts`
- `packages/coding-agent/test/suite/headless-supervisor-systems.test.ts`
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
