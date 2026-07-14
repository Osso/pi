# Resident Supervisor Service

Module boundary: core resident SDK policy service.

The resident Supervisor is a systemd-supervised policy engine that evaluates synchronous approval and goal decisions for Pi sessions. It preserves one global model transcript, reads and writes durable project memories in the shared KB, and returns typed decisions to the calling subsystem. It does not coordinate work across sessions or mutate supervised sessions directly. Implementation details belong in [../wiki/systems/supervisor-service.md](../wiki/systems/supervisor-service.md).

## What it must do

### Service lifecycle and model

- [ ] Run as one resident systemd-supervised SDK service, separate from the resident Architect.
- [ ] Use `openai-codex/gpt-5.6-sol` with low thinking effort.
- [ ] Preserve one global Supervisor transcript across service restarts.
- [ ] Process requests through an event-driven request/response queue rather than polling sessions.
- [ ] Remain local-only without web access.

### Authority boundary

- [ ] Act as a policy engine whose typed response is enforced by the calling subsystem.
- [ ] Read workspace files without modifying them.
- [ ] Read and write the full shared KB.
- [ ] Never edit workspace files, dispatch agents, control processes or sessions, mutate goals directly, or change approval policy directly.
- [ ] Exclude cross-session conflict detection, work coordination, and goal compatibility checks from the initial service.

### Project identity and memory

- [ ] Resolve a canonical project family from `KB/memory/supervisor/projects.json` using configured repository roots, remote repository names, and aliases.
- [ ] Fall back from configured project mappings to the current repository's remote repository name, then to the repository directory basename.
- [ ] Support one canonical project family spanning multiple repositories, including GlobalComix, MangaHelpers, and World of Osso, without hardcoding those projects into service logic.
- [ ] Store Supervisor-owned memory under `KB/memory/supervisor/`, with one memory file per canonical project family and optional global memory.
- [ ] Do not inject all Supervisor memory into model context automatically; let the Supervisor selectively read relevant memory files with its read tools.
- [ ] Permit synchronous KB reads and writes during request evaluation, within the request deadline.

### Request evidence

- [ ] Give every request the canonical project identity and originating session identity.
- [ ] Keep request evidence bounded and specific to the current decision.
- [ ] Never provide historical session transcripts or allow the Supervisor to request additional transcript slices.
- [ ] Let the Supervisor consult KB memory and read-only workspace evidence when current request evidence is insufficient.

### Approval review

- [ ] Replace the existing LLM auto-reviewer with a Supervisor `approval_review` request while preserving the surrounding approval orchestrator and human-review paths.
- [ ] Include the tool name, normalized arguments, current user request, active running goal when present, and applicable preclassified approval rules in the request evidence.
- [ ] Return exactly `approve`, `reject`, or generic `error` for approval review.
- [ ] Enforce a 30-second deadline that includes model work plus synchronous KB reads and writes.
- [ ] Escalate `error`, timeout, invalid response, or unavailable Supervisor to human review.

### Goal completion review

- [ ] Intercept `manage_goal complete` before the calling session marks the running goal complete.
- [ ] Send a `goal_completion_review` request containing the objective, current terminal turn evidence, and proposed completion reason.
- [ ] Return exactly `complete`, `continue`, or generic `error` for goal completion review.
- [ ] Mark the goal complete only when the caller receives `complete`.
- [ ] Keep the goal running and inject concrete Supervisor next-step instructions when the caller receives `continue`.
- [ ] Require the Supervisor to make its best judgment between `complete` and `continue` when evidence is uncertain; missing evidence alone is not an error.

### Goal idle review

- [ ] Preserve the goal extension's existing `agent_end` trigger and all existing guards exactly: the event already occurs after the tool loop reaches a terminal response with no further tool calls, and no redundant tool-call check may be added.
- [ ] Trigger `goal_idle_review` only at the current continuation point for a running goal, after abort, pending-message, error-stop, and empty-response handling.
- [ ] Replace only the current unconditional continuation-message decision with Supervisor evaluation.
- [ ] Return exactly `complete`, `continue`, or generic `error` for goal idle review.
- [ ] Mark the goal complete when the caller receives `complete`.
- [ ] Submit the Supervisor's concrete instructions as the follow-up continuation prompt when the caller receives `continue`.
- [ ] Require best judgment between `complete` and `continue` despite uncertainty.
- [ ] On goal `error`, keep the goal running, stop automatic continuation, and display a visible error without requiring human approval.
- [ ] Enforce a two-minute deadline for goal reviews.

### Scheduling and preemption

- [ ] Give approval reviews priority over goal reviews and memory work.
- [ ] Abort and requeue an active goal review when an approval request arrives.
- [ ] Preserve the original goal request evidence when requeuing it.
- [ ] Process the approval immediately after preemption.
- [ ] Keep the requeued goal review within its original two-minute request deadline.

### Failure handling

- [ ] Return generic `error` for service, transport, timeout, model, tool, or response-validation failures.
- [ ] Fail approval reviews to human escalation.
- [ ] Fail goal reviews visibly without completing the goal, continuing automatically, or invoking human approval.

## How it works

- [ ] See [`docs/wiki/systems/supervisor-service.md`](../wiki/systems/supervisor-service.md).
- [ ] Integrates with [`approval-system.md`](approval-system.md).
- [ ] Integrates with [`goal-system.md`](goal-system.md).
- [ ] Reuses applicable resident-service lifecycle patterns from [`architect-service.md`](architect-service.md) without inheriting the Architect's advisory-only contract.

## Implementation inventory

- Not implemented. Expected inventory will include the resident Supervisor service, control-DB request repository, approval integration, goal integration, systemd unit, deployment wiring, and KB project-identity resolver.

## Tests asserting this spec

- Not implemented.

## Known gaps (current cycle)

- [ ] Define and test the typed Supervisor request and response protocol.
- [ ] Implement the persistent request/response repository with priority and preemption semantics.
- [ ] Implement the resident Supervisor SDK service and restricted tool boundary.
- [ ] Implement KB-backed canonical project resolution and memory access.
- [ ] Replace the approval auto-reviewer call with `approval_review`.
- [ ] Gate explicit goal completion with `goal_completion_review`.
- [ ] Replace the existing `agent_end` continuation decision with `goal_idle_review` without changing its trigger or guards.
- [ ] Deploy and verify the systemd service.

## Out of scope

- Cross-session work coordination, checkout ownership, duplicate-work detection, or incompatible-goal detection.
- Full or on-demand historical transcript delivery.
- Automatic web research.
- Workspace mutation, autonomous remediation, agent dispatch, or direct session/goal mutation by the Supervisor.
- Separate models for approvals and goals.
