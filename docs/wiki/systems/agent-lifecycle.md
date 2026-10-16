# Agent lifecycle

Contract: [Agent lifecycle](../../specs/agent-lifecycle.md). Related implementation: [multi-agent](multi-agent.md).

## Durable state and authority

[`LifecycleCoordinator`](../../../packages/coding-agent/src/core/lifecycle-coordinator.ts) builds child snapshots and submits creation, steering, cancellation, terminalization, and recovery commands. [`session-control-db.ts`](../../../packages/coding-agent/src/core/session-control-db.ts) owns transactional validation and revision advancement. Rows are session-path/agent-ID scoped; ownership includes owner session/agent and process identity, including runtime incarnation. Callers do not supply a revision counter.

Construction succeeds before `commitRunningChild` persists revision 1 plus ownership. Failure persists a failed child. Attachments initially enter `waiting_for_input`. Active states are `running`, `waiting_for_input`, `steering_pending`, and `cancelling`; terminal states are `completed`, `failed`, and `aborted`. Steering enqueue couples lifecycle and mailbox persistence; delivery acknowledgement returns to running.

Terminal writes preflight ownership, legal transition and descendant state, then recheck snapshots/ownership and absence of active descendants in an immediate transaction. The terminal row and one pending outbox row commit together. Exact replay returns the existing result; notification delivery is not terminal truth. [`multi-agent-store.ts`](../../../packages/coding-agent/src/core/multi-agent-store.ts) supplies projections and metadata rather than lifecycle commands.

## Execution and restart

[`agents-core/runtime.ts`](../../../packages/coding-agent/extensions/agents-core/src/runtime.ts) drains coordination, settles descendants and finalizes through the coordinator. Cancellation records intent before abort; a noncooperative runtime can remain cancelling until exact-owner acknowledgement or dead-owner recovery. Before child terminalization, [`detached-runtime-cancellation.ts`](../../../packages/coding-agent/extensions/agents-core/src/detached-runtime-cancellation.ts) requests silent cleanup of directly owned detached Bash/Pyrun jobs; descendants still must settle.

The approved contract makes session-path-scoped control-DB lifecycle and exact ownership the restart authority. Recovery must validate the persisted child transcript file and session header against recorded identity, reacquire ownership, and use transcript-backed session dispatch, descendants before parents. Forked supervisor paths cannot inherit source agents. Production parent-journal writes, journal-membership admission, and compaction admission repair must be removed; historical `agent_start`/`agent_complete` rows remain readable by `agent_viewer` with `storeSessionId` and `trace: true` as audit evidence only, never recovery authority. Missing evidence remains absent; the trace does not repair state.

Dead detached runners use [`detached-job-lifecycle.ts`](../../../packages/coding-agent/src/core/detached-job-lifecycle.ts); output artifacts are not replayed as outcomes. Runtime incarnation distinguishes exec restart from the former owner even with unchanged PID.

## Limits and evidence

Deliberate `interrupted`/paused state is **unimplemented**. The Control-DB-only decision supersedes journal admission, not transcript validation or ownership fencing.

Restart, GREEN pre-deployment integration/source proof, retained repair provenance, and pending main-owned full-check/deployment/runtime-adoption gates live in [current-cycle evidence](../../specs/agent-lifecycle.md#known-gaps-current-cycle). Historical mailbox diagnosis limits and explicit-body proof live in [mailbox proof](../../specs/multi-agent.md#mailbox-proof-current-cycle).

Additional evidence locations (not exhaustive proof of the contract): [coordinator](../../../packages/coding-agent/test/lifecycle-coordinator.test.ts) (creation, ownership and transitions), [store](../../../packages/coding-agent/test/multi-agent-store.test.ts) (projection/metadata), [extension](../../../packages/coding-agent/test/multi-agent-extension.test.ts) (dispatch/cancel/recovery), [headless processes](../../../packages/coding-agent/test/suite/headless-pi.test.ts) (restart), [cancellation reconciliation](../../../packages/coding-agent/test/suite/agent-cancellation-reconciliation.test.ts) (silent detached cleanup), and [orphaned runners](../../../packages/coding-agent/test/orphaned-detached-reconciliation.test.ts) (liveness and outbox guards). Only the linked SSOT verification evidence establishes passing scope.
