# Resident Supervisor Service

Module boundary: core resident SDK policy service.

The resident Supervisor is a systemd-supervised policy engine that evaluates synchronous approval and goal decisions for Pi sessions. It preserves one global model transcript, reads and writes durable project memories in the shared KB, and returns typed decisions to the calling subsystem. It does not coordinate work across sessions or mutate supervised sessions directly. Implementation details belong in [../wiki/systems/supervisor-service.md](../wiki/systems/supervisor-service.md).

## What it must do

### Service lifecycle and model

- [x] Run as one resident systemd-supervised SDK service, separate from the resident Architect.
- [x] Use `openai-codex/gpt-5.6-sol` with low thinking effort.
- [x] Preserve one global Supervisor model transcript across requests and service restarts. Proactively compact the shared context before a bounded request when usage reaches 75%, preserving prior decisions, project-specific policies, and reusable approval rationale rather than resetting history. Invalidate provider continuation state after compaction so the next request starts from the compacted local context rather than the pre-compaction remote chain.
- [x] Process requests through an event-driven request/response queue rather than polling sessions.
- [x] Remain local-only without web access.

### Resident console

- [x] `pi --supervisor` attaches to an already-running Supervisor through its owner-only local console socket; it never starts a second Supervisor, creates a second session owner, or changes the resident cwd.
- [x] Reject missing or unavailable Supervisor sockets explicitly, while preserving the positional `pi supervisor` service entrypoint.
- [x] Send the resident session identity, fixed cwd, generation, and complete current branch on attach, then stream live session events.
- [x] Accept interactive console prompts and an optional trailing initial prompt, with exactly one writable console client at a time.
- [x] Keep the resident process as the sole transcript, model, tool, and cwd owner; process typed Supervisor requests before queued console prompts and never interleave turns.

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
- [x] Require the model to call the terminating structured `supervisor_response` tool exactly once as the final action for each request; do not ask it to emit JSON text, markdown, or `end_turn` around that call. Extract only that current-request structured response, reject strict JSON text with trailing prose or malformed/partial content, and never reuse historical response text.

### Supervisor advisory

- [x] Expose `ask_supervisor` only to main sessions; sub-agents cannot use it.
- [x] Persist advisory requests as `supervisor_advisory` queue rows and return a text-only `{ kind: "advisory", answer }` response; advisory responses cannot control the caller or mutate goals, policies, sessions, processes, or agents.
- [x] Bound inputs to a 4,000-character question and optional 8,000-character context.
- [x] Enforce a three-minute request deadline.
- [x] Schedule advisory requests below approval and goal reviews.

### Approval review

- [x] Replace the existing LLM auto-reviewer with a Supervisor `approval_review` request while preserving the surrounding approval orchestrator and human-review paths.
- [x] Auto-approve inherently read-only built-in tools (`read`, `grep`, `find`, `ls`, `outline`, `symbol`, and `references`) after extension and permission hooks have had an opportunity to deny them, without consulting the Supervisor or prompting the user.
- [x] Include the tool name, normalized arguments, current user request, active running goal when present, and applicable preclassified approval rules in the request evidence.
- [x] Return exactly `approve`, `reject`, or generic `error` for approval review.
- [x] Enforce a 30-second deadline that includes model work plus synchronous KB reads and writes.
- [x] Escalate `error`, timeout, invalid response, or unavailable Supervisor to human review.

### Goal completion review

- [x] Intercept `manage_goal complete` before the calling session marks the running goal complete.
- [x] Send a `goal_completion_review` request containing the objective and the caller-provided completionReport verbatim; later wait wakeups preserve that report and add bounded wake evidence.
- [x] Include all unconsumed ordered `conversationEvents` in idle and completion goal reviews, preserve them across failed, stale, or canceled reviews, and consume them only after applying `complete`, `continue`, `wait`, or `pause`.
- [x] Return exactly `complete`, `continue`, `wait`, `pause`, or generic `error` for goal completion review.
- [x] Mark the goal complete only when the caller receives `complete`, persisting the verbatim completionReport as completionReason.
- [x] Clear stored goal-review conversation evidence when completion is applied.
- [x] Keep the goal running and inject concrete Supervisor next-step instructions when the caller receives `continue`.
- [x] On `wait`, append a durable Supervisor status entry; if agents are active, start a cancellable background `wait_agents` and re-review after wake, otherwise schedule the five-minute countdown and re-review, including when progress depends on an external condition that can be rechecked.
- [x] On `error`, append durable status and keep the completion request unresolved without scheduling automatic re-review; rejected completion reports remain visible with the Supervisor's reason in durable status.
- [x] Leave the goal active without another continuation only when required user action or input is needed and no automatic recheck can advance progress; the caller receives `pause` only for that manual stop condition.
- [x] Require the Supervisor to make its best judgment between `complete`, actionable `continue`, scheduled `wait` for recheckable asynchronous or external progress, and manual-only `pause` from the supplied report when evidence is uncertain; the caller must provide a nonblank report, and the system never infers completion evidence automatically.

### Goal idle review

- [x] Preserve the goal extension's existing `agent_end` trigger and all existing guards exactly: the event already occurs after the tool loop reaches a terminal response with no further tool calls, and no redundant tool-call check may be added.
- [x] Trigger `goal_idle_review` only at the current continuation point for a running goal, after pending-message, abort, error-stop, and empty-response handling.
- [x] Send ordered unconsumed user and successful `end_turn` conversation events to idle review without sending `terminalTurn`; explicitly paused goals retain their ordered events until review after resume.
- [x] Exclude extension-generated input and failed `end_turn` calls, preserve conversation evidence across Supervisor errors and stale or canceled reviews, and consume it after an applied idle-review decision.
- [x] Keep the goal running when queued interactive input interrupts the current turn; only an abort without pending input pauses it.
- [x] Replace only the current unconditional continuation-message decision with Supervisor evaluation.
- [x] Return exactly `complete`, `continue`, `wait`, `pause`, or generic `error` for goal idle review.
- [x] Mark the goal complete when the caller receives `complete`.
- [x] Submit the Supervisor's concrete, actionable instructions as the follow-up continuation prompt when the caller receives `continue`.
- [x] Keep the goal active on `wait`, append a durable status entry, and re-run review after agent wake or the scheduled five-minute countdown, including for external conditions that can be rechecked.
- [x] Leave the goal active without another continuation when the caller receives `pause` because required user action or input is needed and no automatic recheck can advance progress.
- [x] Require best judgment between `complete`, actionable `continue`, scheduled `wait` for recheckable asynchronous or external progress, and manual-only `pause` despite uncertainty.
- [x] On goal `error`, keep the goal running, append visible durable error status without requiring human approval, and use the same agent-wake or five-minute re-review path as `wait`; rejected scheduled work remains visibly durable.
- [x] Retry before review when pending input is transient, preserve reviewed decisions when input becomes pending during review, and cancel in-flight reviews, deferred decisions, waits, discovery calls, and timers on input, new turns, goal lifecycle changes, and shutdown; recheck cancellation generation and goal identity before applying an asynchronous decision.
- [x] Enforce a three-minute deadline for goal reviews.

### Scheduling and preemption

- [x] Give approval reviews priority over goal reviews and memory work.
- [x] Abort and requeue an active goal review when an approval request arrives.
- [x] Preserve the original goal request evidence when requeuing it.
- [x] Process the approval immediately after preemption.
- [x] Keep the requeued goal review within its original three-minute request deadline.

### Failure handling

- [x] Return generic `error` for service, transport, timeout, model, tool, or response-validation failures.
- [x] Retry resident goal-review request timeouts up to three attempts with bounded exponential backoff and jitter before returning generic `error`; other request kinds retain single-attempt timeout behavior.
- [x] Fail approval reviews to human escalation.
- [x] Fail goal reviews visibly without completing the goal or invoking human approval; idle-review errors enter bounded wake/re-review scheduling, while completion-review errors remain unresolved until another explicit completion attempt.

## How it works

- [x] See [`docs/wiki/systems/supervisor-service.md`](../wiki/systems/supervisor-service.md).
- [x] Integrates with [`approval-system.md`](approval-system.md).
- [x] Integrates with [`goal-system.md`](goal-system.md).
- [x] Reuses applicable resident-service lifecycle patterns from [`architect-service.md`](architect-service.md) without inheriting the Architect's advisory-only contract.

## Implementation inventory

- `packages/coding-agent/src/supervisor/main.ts` — resident Sol SDK service, restricted tool surface, persistent transcript, and request loop.
- `packages/coding-agent/src/supervisor/service.ts` — bounded prompts, typed response validation, deadlines, and approval preemption.
- `packages/coding-agent/src/supervisor/client.ts` — durable synchronous caller transport.
- `packages/coding-agent/src/supervisor/request-wake.ts` — owner-only Unix-socket wake notification for the durable request queue.
- `packages/coding-agent/src/core/resident-console-transport.ts` — owner-only attach protocol, branch snapshot, live events, and single-client prompt transport.
- `packages/coding-agent/src/cli/resident-console-command.ts` — `--supervisor` console client and optional initial prompt handling.
- `packages/coding-agent/src/main.ts` — early dispatch for resident-console flags without changing service commands.
- `packages/coding-agent/src/supervisor/project-resolver.ts` — KB config loading and canonical project-family resolution.
- `packages/coding-agent/src/supervisor/approval-reviewer.ts` — approval decision enforcement and human escalation.
- `packages/coding-agent/src/core/session-control-db.ts` — durable `supervisor_requests` repository.
- `packages/coding-agent/src/core/tools/ask-supervisor.ts` — main-session-only bounded advisory tool.
- `packages/coding-agent/src/core/agent-session.ts` — LLM-approved preset integration.
- `packages/coding-agent/extensions/goal/src/index.ts` — completion and existing `agent_end` continuation gates.
- `packages/coding-agent/extensions/goal/src/goal-review-evidence.ts` — supplies ordered unconsumed conversation events to goal reviews and consumes them after applied decisions.
- `packages/coding-agent/extensions/goal/src/goal-scheduling.ts` — cancellable agent waits, pending-decision handoff, timed review, identity rechecks, and visible scheduling failures.
- `packages/coding-agent/extensions/goal/src/rendering.ts` — durable Supervisor status entries and tagged continuation rendering.
- `packages/coding-agent/systemd/pi-supervisor.service` / `deploy.sh` — installed Bun-compiled Pi binary service lifecycle.

## Tests asserting this spec

- `packages/coding-agent/test/supervisor-request-repository.test.ts`
- `packages/coding-agent/test/supervisor-project-resolver.test.ts`
- `packages/coding-agent/test/supervisor-client.test.ts`
- `packages/coding-agent/test/supervisor-service.test.ts` — advisory response contract and validation.
- `packages/coding-agent/test/supervisor-approval-reviewer.test.ts`
- `packages/coding-agent/test/list-sessions-broadcast-tools.test.ts` — main-session-only tool registration and access.
- `packages/coding-agent/test/suite/headless-supervisor-systems.test.ts` — real-process advisory tool flow.
- `packages/coding-agent/test/goal-extension.test.ts` — ordered idle/completion conversation evidence, paused accumulation, filtering, preservation, consumption, and lifecycle clearing.
- `packages/coding-agent/test/suite/agent-session-model-extension.test.ts`
- `packages/coding-agent/test/resident-console-command.test.ts`
- `packages/coding-agent/test/resident-console-client.test.ts`
- `packages/coding-agent/test/supervisor-resident-console.test.ts`

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
