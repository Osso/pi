# Resident Supervisor Service

Module boundary: core resident SDK policy service.

The resident Supervisor is a systemd-supervised policy engine that evaluates synchronous approval and goal decisions for Pi sessions. It preserves one global model transcript, reads and writes durable project memories in the shared KB, and returns typed decisions to the calling subsystem. It does not coordinate work across sessions or mutate supervised sessions directly. Implementation details belong in [../wiki/systems/supervisor-service.md](../wiki/systems/supervisor-service.md).

## What it must do

### Service lifecycle and model

- [x] Run as one resident systemd-supervised SDK service, separate from the resident Architect.
- [x] Use `openai-codex/gpt-5.6-sol` with low thinking effort.
- [x] Preserve one global Supervisor transcript across service restarts.
- [x] Await reload of the caller-provided Supervisor resource loader before `createAgentSession`; with `noExtensions: true`, explicitly load only the Supervisor mutation gate and first-party OpenAI remote compaction, so both are active and persistent Codex transcript overflow recovers through normal AgentSession compact-and-retry.
- [x] Process requests through an event-driven request/response queue rather than polling sessions.
- [x] Remain local-only without web access.

### Authority boundary

- [x] Act as a policy engine whose typed response is enforced by the calling subsystem.
- [x] Read and write only inside the configured shared KB root.
- [x] Keep Bash and Pyrun unavailable to the Supervisor.
- [x] Never edit workspace files, dispatch agents, control processes or sessions, mutate goals directly, or change approval policy directly.
- [x] Exclude cross-session conflict detection, work coordination, and goal compatibility checks from the initial service.

### Project identity and memory

- [x] Resolve a canonical project family from `KB/memory/supervisor/projects.json` using configured repository roots and owner/repository remote identities.
- [x] Fall back from configured project mappings to the current repository's remote repository basename, then to the repository directory basename.
- [x] Support one canonical project family spanning multiple repositories, including GlobalComix, MangaHelpers, and World of Osso, without hardcoding those projects into service logic.
- [x] Store Supervisor-owned memory under the configured `KB/memory/supervisor/`, with one memory file per canonical project family and optional global memory.
- [x] Do not inject all Supervisor memory into model context automatically; let the Supervisor selectively read relevant memory files with its read tools.
- [x] Permit synchronous KB reads and writes during request evaluation, within the request deadline.

### Request evidence

- [x] Give every request the canonical project identity and originating session identity.
- [x] Keep request evidence bounded and specific to the current decision.
- [x] Never provide historical session transcripts or allow the Supervisor to request additional transcript slices.
- [x] Let the Supervisor consult KB memory when current request evidence is insufficient.
- [x] Extract the model response only from the terminal assistant entry produced during the current request; return an error instead of reusing prior or intermediate assistant text when the current request has no non-empty successful terminal response.

### Approval review

- [x] Replace the existing LLM auto-reviewer with a Supervisor `approval_review` request while preserving the surrounding approval orchestrator and human-review paths.
- [x] Include the tool name, normalized arguments, current user request, active running goal when present, and applicable preclassified approval rules in the request evidence.
- [x] Return exactly `approve`, `reject`, or generic `error` for approval review.
- [x] Enforce a 30-second deadline that includes model work plus synchronous KB reads and writes.
- [x] Escalate `error`, timeout, invalid response, or unavailable Supervisor to human review.

### Goal completion review

- [x] Intercept `manage_goal complete` before the calling session marks the running goal complete.
- [x] Send a `goal_completion_review` request containing the objective, current terminal turn evidence, and proposed completion reason.
- [x] Return exactly `complete`, `continue`, or generic `error` for goal completion review.
- [x] Mark the goal complete only when the caller receives `complete`.
- [x] Keep the goal running and inject concrete Supervisor next-step instructions when the caller receives `continue`.
- [x] Require the Supervisor to make its best judgment between `complete` and `continue` when evidence is uncertain; missing evidence alone is not an error.

### Goal idle review

- [x] Preserve the goal extension's existing `agent_end` trigger and all existing guards exactly: the event already occurs after the tool loop reaches a terminal response with no further tool calls, and no redundant tool-call check may be added.
- [x] Trigger `goal_idle_review` only at the current continuation point for a running goal, after abort, pending-message, error-stop, and empty-response handling.
- [x] Replace only the current unconditional continuation-message decision with Supervisor evaluation.
- [x] Return exactly `complete`, `continue`, or generic `error` for goal idle review.
- [x] Mark the goal complete when the caller receives `complete`.
- [x] Submit the Supervisor's concrete instructions as the follow-up continuation prompt when the caller receives `continue`.
- [x] Require best judgment between `complete` and `continue` despite uncertainty.
- [x] On goal `error`, keep the goal running, stop automatic continuation, and display a visible error without requiring human approval.
- [x] Enforce a three-minute deadline for goal reviews.

### Scheduling and preemption

- [x] Give approval reviews priority over goal reviews and memory work.
- [x] Abort and requeue an active goal review when an approval request arrives.
- [x] Preserve the original goal request evidence when requeuing it.
- [x] Process the approval immediately after preemption.
- [x] Keep the requeued goal review within its original three-minute request deadline.

### Failure handling

- [x] Return generic `error` for service, transport, timeout, model, tool, or response-validation failures.
- [x] Fail approval reviews to human escalation.
- [x] Fail goal reviews visibly without completing the goal, continuing automatically, or invoking human approval.

## How it works

- [x] See [`docs/wiki/systems/supervisor-service.md`](../wiki/systems/supervisor-service.md).
- [x] Integrates with [`approval-system.md`](approval-system.md).
- [x] Integrates with [`goal-system.md`](goal-system.md).
- [x] Reuses applicable resident-service lifecycle patterns from [`architect-service.md`](architect-service.md) without inheriting the Architect's advisory-only contract.

## Implementation inventory

- `packages/coding-agent/src/supervisor/main.ts` — resident Sol SDK service, restricted tool surface, persistent transcript, and request loop.
- `packages/coding-agent/src/supervisor/service.ts` — bounded prompts, typed response validation, deadlines, and approval preemption.
- `packages/coding-agent/src/supervisor/client.ts` — durable synchronous caller transport.
- `packages/coding-agent/src/supervisor/project-resolver.ts` — KB config loading and canonical project-family resolution.
- `packages/coding-agent/src/supervisor/approval-reviewer.ts` — approval decision enforcement and human escalation.
- `packages/coding-agent/src/core/session-control-db.ts` — durable `supervisor_requests` repository.
- `packages/coding-agent/src/core/agent-session.ts` — LLM-approved preset integration.
- `packages/coding-agent/extensions/goal/src/index.ts` — completion and existing `agent_end` continuation gates.
- `packages/coding-agent/systemd/pi-supervisor.service` / `deploy.sh` — installed Bun-compiled Pi binary service lifecycle.

## Tests asserting this spec

- `packages/coding-agent/test/supervisor-request-repository.test.ts`
- `packages/coding-agent/test/supervisor-project-resolver.test.ts`
- `packages/coding-agent/test/supervisor-client.test.ts`
- `packages/coding-agent/test/supervisor-service.test.ts`
- `packages/coding-agent/test/supervisor-approval-reviewer.test.ts`
- `packages/coding-agent/test/goal-extension.test.ts`
- `packages/coding-agent/test/suite/agent-session-model-extension.test.ts`

## Known gaps (current cycle)

- [x] Define and test the typed Supervisor request and response protocol.
- [x] Implement the persistent request/response repository with priority and preemption semantics.
- [x] Implement the resident Supervisor SDK service and restricted tool boundary.
- [x] Implement KB-backed canonical project resolution and memory access.
- [x] Replace the approval auto-reviewer call with `approval_review`.
- [x] Gate explicit goal completion with `goal_completion_review`.
- [x] Replace the existing `agent_end` continuation decision with `goal_idle_review` without changing its trigger or guards.
- [x] Deploy and verify the systemd service.

## Out of scope

- Cross-session work coordination, checkout ownership, duplicate-work detection, or incompatible-goal detection.
- Full or on-demand historical transcript delivery.
- Automatic web research.
- Workspace mutation, autonomous remediation, agent dispatch, or direct session/goal mutation by the Supervisor.
- Separate models for approvals and goals.
