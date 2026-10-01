# Agent lifecycle

Contract: [Agent lifecycle](../../specs/agent-lifecycle.md). Related implementation: [multi-agent](multi-agent.md).

## Durable state and authority

[`LifecycleCoordinator`](../../../packages/coding-agent/src/core/lifecycle-coordinator.ts) builds child snapshots and submits creation, steering, cancellation, terminalization, and recovery commands. [`session-control-db.ts`](../../../packages/coding-agent/src/core/session-control-db.ts) owns transactional validation and revision advancement. Rows are session-path/agent-ID scoped; ownership includes owner session/agent and process identity, including runtime incarnation. Callers do not supply a revision counter.

Construction succeeds before `commitRunningChild` persists revision 1 plus ownership. Failure persists a failed child. Attachments initially enter `waiting_for_input`. Active states are `running`, `waiting_for_input`, `steering_pending`, and `cancelling`; terminal states are `completed`, `failed`, and `aborted`. Steering enqueue couples lifecycle and mailbox persistence; delivery acknowledgement returns to running.

Terminal writes preflight ownership, legal transition and descendant state, then recheck snapshots/ownership and absence of active descendants in an immediate transaction. The terminal row and one pending outbox row commit together. Exact replay returns the existing result; notification delivery is not terminal truth. [`multi-agent-store.ts`](../../../packages/coding-agent/src/core/multi-agent-store.ts) supplies projections and metadata rather than lifecycle commands.

## Execution and restart

[`agents-core/runtime.ts`](../../../packages/coding-agent/extensions/agents-core/src/runtime.ts) drains coordination, settles descendants and finalizes through the coordinator. Cancellation records intent before abort; a noncooperative runtime can remain cancelling until exact-owner acknowledgement or dead-owner recovery. Before child terminalization, [`detached-runtime-cancellation.ts`](../../../packages/coding-agent/extensions/agents-core/src/detached-runtime-cancellation.ts) requests silent cleanup of directly owned detached Bash/Pyrun jobs; descendants still must settle.

[`parent-agent-journal.ts`](../../../packages/coding-agent/extensions/agents-core/src/parent-agent-journal.ts) appends `agent_start`/`agent_complete` custom entries and refreshes active records across compaction. Recovery orders descendants before parents and uses transcript-backed session dispatch. Dead detached runners use [`detached-job-lifecycle.ts`](../../../packages/coding-agent/src/core/detached-job-lifecycle.ts); output artifacts are not replayed as outcomes. Runtime incarnation distinguishes exec restart from the former owner even with unchanged PID.

## Limits and evidence

Deliberate `interrupted`/paused state is **unimplemented**. Strict journal-only admission is not unconditional in `recoverAgents`: missing session-manager context or missing transcript path admits recovery without journal membership; production paths must supply these identities rather than treating that branch as proof of the strict contract.

Tests inspected, not run: [coordinator](../../../packages/coding-agent/test/lifecycle-coordinator.test.ts) (creation, ownership and transitions), [store](../../../packages/coding-agent/test/multi-agent-store.test.ts) (projection/metadata), [extension](../../../packages/coding-agent/test/multi-agent-extension.test.ts) (dispatch/cancel/recovery), [headless processes](../../../packages/coding-agent/test/suite/headless-pi.test.ts) (restart), [cancellation reconciliation](../../../packages/coding-agent/test/suite/agent-cancellation-reconciliation.test.ts) (silent detached cleanup), and [orphaned runners](../../../packages/coding-agent/test/orphaned-detached-reconciliation.test.ts) (liveness and outbox guards). These are evidence locations, not a claim that every contract invariant was exercised here.
