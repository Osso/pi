# Resident Supervisor Service

Module boundary: core resident SDK policy service.

The resident Supervisor is a peer-unblocking policy engine that evaluates synchronous approval and goal decisions for Pi sessions. Pi can own it as a detached resident, while systemd remains an optional external owner. It preserves one global model transcript, reads and writes durable project memories in the shared KB, and returns typed decisions to the calling subsystem. It does not coordinate work across sessions or mutate supervised sessions directly. Implementation details belong in [../wiki/systems/supervisor-service.md](../wiki/systems/supervisor-service.md).

## What it must do

### Service lifecycle and model

- [x] Run as one resident SDK service, separate from the resident Architect; systemd ownership is optional.
- [x] Before posting a Supervisor request on Linux or macOS, probe for a compatible resident and automatically connect or spawn the current Pi launcher as a detached `pi supervisor` process.
- [x] Serialize concurrent startup through an atomic state-directory lock, recheck readiness after acquiring it, recover stale startup locks, and launch exactly one resident.
- [x] Preserve Bun-binary launches directly and Node development or installed launches through the active CLI entrypoint and runtime flags.
- [x] Expose read-only resident identity only when the console snapshot explicitly includes `ready: true`, alongside Pi version, PID, executable, optional entrypoint, unique service-start instance ID, and Pi-versus-external ownership without claiming writable console ownership.
- [x] Reuse compatible externally managed residents, replace only verified incompatible Pi-managed residents, and report an explicit restart requirement for incompatible externally managed residents.
- [x] Bound startup/readiness failures and return them through the typed Supervisor error path without posting an unserviceable durable request.
- [x] Use `openai-codex/gpt-5.6-sol` with low thinking effort.
- [x] Preserve one global Supervisor model transcript across requests and service restarts. Proactively compact the shared context before a bounded request when usage reaches 75%, preserving prior decisions, project-specific policies, and reusable approval rationale rather than resetting history. Invalidate provider continuation state after compaction so the next request starts from the compacted local context rather than the pre-compaction remote chain.
- [x] Process requests through an event-driven request/response queue rather than polling sessions. Idle recovery probes the Supervisor request queue read-only for expired pending or claimed work; when recovery is needed, expired requests are completed and remaining claimed requests are requeued in one immediate transaction.
- [x] Remain local-only without web access.
- [x] Default deployment to Pi-managed lazy Supervisor startup: on Linux, invoke `scripts/configure-resident-services.sh <pi-binary> autostart` to stop, disable, and remove obsolete Architect and Supervisor user units; on Darwin, skip systemd configuration and reject the systemd opt-in explicitly. Select systemd mode only with `PI_DEPLOY_CONFIGURE_RESIDENT_SERVICES=1 ./deploy.sh`; direct one-argument `scripts/configure-resident-services.sh <pi-binary>` remains an explicit systemd installer.

### Resident console

- [x] `pi --supervisor` attaches to an already-running Supervisor through its owner-only local console socket; it never starts a second Supervisor, creates a second session owner, or changes the resident cwd.
- [x] Reject missing or unavailable Supervisor sockets explicitly, while preserving the positional `pi supervisor` service entrypoint.
- [x] Send the resident session identity, fixed cwd, generation, and complete current branch on attach, then stream live session events.
- [x] Accept interactive console prompts and an optional trailing initial prompt, with exactly one writable console client at a time; a new console attachment replaces and disconnects the previous client without replacing the resident session.
- [x] Render the text from advisory `supervisor_response` tool results as the visible console answer instead of the internal response-recorded acknowledgement.
- [x] Keep the resident process as the sole transcript, model, tool, and cwd owner; process typed Supervisor requests before queued console prompts and never interleave turns.

### Authority boundary

- [x] Act as a peer-unblocking policy engine, not a routine task manager: preserve agent autonomy, maintain cumulative parent-goal consistency across requests, and intervene only on evidence-backed exceptions; the calling subsystem enforces the typed response.
- [x] Detect narrowed or lost goals, dropped requirements, exclusions, or completion criteria, contradictions between claims and evidence, repeated or circular work, and missing completion proof without prescribing routine decomposition; only an explicit user instruction may reset or narrow a known parent objective.
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

- [x] Expose `ask_supervisor` only to current main/orchestrator runtimes; explicit runtime child identity
      remains authoritative, and historical `is_subagent` transcript provenance alone does not reject a
      session opened as the main orchestrator. Sub-agents cannot use it.
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
- [x] Keep the goal running when the caller receives `continue`; use exactly `Continue working toward the active goal.` when the agent can continue autonomously, and reserve specific Supervisor instructions for an evidence-backed omission, repeated failed or circular work, lost objective scope, or missing completion proof, naming only the exception and smallest corrective action.
- [x] On `wait`, append one durable Supervisor status entry with one absolute five-minute `reviewAt` deadline, regardless of whether agents are active; active-agent mode starts a cancellable background `wait_agent`, agent completion reviews early, deadline expiry cancels `wait_agent` and reviews, the first path wins without duplicate review, and `wait_agent` failure retains the original deadline for timed review.
- [x] On `error`, append durable status and keep the completion request unresolved without scheduling automatic re-review; rejected completion reports remain visible with the Supervisor's reason in durable status.
- [x] Leave the goal active without another continuation only when required user action or input is needed and no automatic recheck can advance progress; the caller receives `pause` only for that manual stop condition.
- [x] Treat supplied objectives and current progress claims as claims about the active goal; preserve any known unfinished parent objective from Supervisor context or KB memory when judging completion, so a child slice cannot replace the broader objective.
- [x] Require the Supervisor to make its best judgment between `complete`, autonomous or corrective `continue`, scheduled `wait` for recheckable asynchronous or external progress, and manual-only `pause` from the supplied report; uncertainty alone uses generic continuation rather than invented oversight, the caller must provide a nonblank report, and the system never infers completion evidence automatically.

### Goal idle review

- [x] Preserve the goal extension's existing `agent_end` trigger and all existing guards exactly: the event already occurs after the tool loop reaches a terminal response with no further tool calls, and no redundant tool-call check may be added.
- [x] Trigger `goal_idle_review` only at the current continuation point for a running goal, after pending-message, abort, error-stop, and empty-response handling; deferred error status remains suppressed while `ExtensionContext.hasActiveRetry()` is true, and a terminal skip is reported only after retry settlement.
- [x] Send ordered unconsumed user and successful `end_turn` conversation events to idle review without sending `terminalTurn`; explicitly paused goals retain their ordered events until review after resume.
- [x] Exclude extension-generated input and failed `end_turn` calls, preserve conversation evidence across Supervisor errors and stale or canceled reviews, and consume it after an applied idle-review decision.
- [x] Keep the goal running when queued interactive input interrupts the current turn; only an abort without pending input pauses it.
- [x] Replace only the current unconditional continuation-message decision with Supervisor evaluation.
- [x] Return exactly `complete`, `continue`, `wait`, `pause`, or generic `error` for goal idle review.
- [x] Mark the goal complete when the caller receives `complete`.
- [x] Submit exactly `Continue working toward the active goal.` when competent progress can continue without help; submit a specific corrective prompt only for an evidence-backed omission such as unhandled pagination or an omitted required element, repeated failed or circular work, lost objective scope, or missing completion proof, naming only the exception and smallest corrective action.
- [x] Keep the goal active on `wait`, append one durable status entry with one absolute five-minute `reviewAt`, and re-run review after the first agent wake or deadline, including for external conditions that can be rechecked; cancel the losing wake path and never schedule duplicate review work.
- [x] Leave the goal active without another continuation when the caller receives `pause` because required user action or input is needed and no automatic recheck can advance progress.
- [x] Preserve the cumulative unfinished parent objective throughout continuation review; a bounded request or current subtask never replaces remaining requirements, exclusions, or completion criteria.
- [x] Require best judgment between `complete`, autonomous or corrective `continue`, scheduled `wait` for recheckable asynchronous or external progress, and manual-only `pause`; do not restate plans, prescribe routine steps, or invent oversight when the agent can determine how to continue.
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

- [x] Caller cancellation stops polling and retries, atomically moves a sender-owned pending or claimed request to terminal `cancelled`, wakes the resident, aborts active evaluation, and prevents later claim or completion.
- [x] Interactive Escape reaches an active goal review through global input even when the caller is idle and the wait loader owns focus, then clears the loader without applying a stale decision.
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
- `packages/coding-agent/src/supervisor/service.ts` — bounded prompts, typed response validation, deadlines, approval preemption, and active-evaluation cancellation.
- `packages/coding-agent/src/supervisor/client.ts` — ensures resident readiness, performs durable synchronous caller transport, and propagates caller cancellation.
- `packages/coding-agent/src/supervisor/ensure-running.ts` — cross-platform probe, singleton startup lock, detached launch, compatibility checks, and Pi-managed replacement.
- `packages/coding-agent/src/supervisor/request-wake.ts` — owner-only Unix-socket wake notification for the durable request queue.
- `packages/coding-agent/src/core/resident-console-transport.ts` — owner-only attach protocol, branch snapshot, live events, and single-client prompt transport.
- `packages/coding-agent/src/cli/resident-console-command.ts` — `--supervisor` console client and optional initial prompt handling.
- `packages/coding-agent/src/main.ts` — early dispatch for resident-console flags without changing service commands.
- `packages/coding-agent/src/supervisor/project-resolver.ts` — KB config loading and canonical project-family resolution.
- `packages/coding-agent/src/supervisor/approval-reviewer.ts` — approval decision enforcement and human escalation.
- `packages/coding-agent/src/core/session-control-db.ts` — durable `supervisor_requests` repository.
- `packages/coding-agent/src/core/tools/ask-supervisor.ts` — main-session-only bounded advisory tool.
- `packages/coding-agent/src/core/agent-session.ts` / `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — active-review cancellation registration and global Escape routing.
- `packages/coding-agent/extensions/goal/src/index.ts` — completion and existing `agent_end` continuation gates.
- `packages/coding-agent/extensions/goal/src/goal-review-evidence.ts` — supplies ordered unconsumed conversation events to goal reviews and consumes them after applied decisions.
- `packages/coding-agent/extensions/goal/src/goal-scheduling.ts` — cancellable agent waits, pending-decision handoff, timed review, identity rechecks, and visible scheduling failures.
- `packages/coding-agent/extensions/goal/src/rendering.ts` — durable Supervisor status entries and tagged continuation rendering.
- `packages/coding-agent/systemd/pi-supervisor.service` / `deploy.sh` — optional systemd service template and default lazy-start deployment lifecycle.
- `scripts/configure-resident-services.sh` — explicit systemd installation or deployment-mode cleanup of Architect and Supervisor user units.

## Tests asserting this spec

- `packages/coding-agent/test/supervisor-request-repository.test.ts`
- `packages/coding-agent/test/supervisor-project-resolver.test.ts`
- `packages/coding-agent/test/supervisor-client.test.ts`
- `packages/coding-agent/test/supervisor-ensure-running.test.ts`
- `packages/coding-agent/test/suite/supervisor-autostart-runtime.test.ts` — real-process detached startup and concurrent reuse.
- `packages/coding-agent/test/supervisor-service.test.ts` — advisory response contract, validation, and claimed-request evaluation cancellation.
- `packages/coding-agent/test/interactive-mode-status.test.ts` — editor and global-input Escape routing while Supervisor review is active.
- `packages/coding-agent/test/supervisor-approval-reviewer.test.ts`
- `packages/coding-agent/test/list-sessions-broadcast-tools.test.ts` — main-session-only tool registration and access.
- `packages/coding-agent/test/suite/headless-supervisor-systems.test.ts` — real-process advisory flow and Supervisor continuation delivery after terminal tool results.
- `packages/coding-agent/test/goal-extension.test.ts` — ordered idle/completion conversation evidence, paused accumulation, filtering, preservation, consumption, and lifecycle clearing.
- `packages/coding-agent/test/goal-error-status-scheduling.test.ts` — active-retry gating for deferred terminal error status.
- `packages/coding-agent/test/suite/goal-extension-runtime.test.ts` — retry-success cancellation and agent-end continuation ordering.
- `packages/coding-agent/test/suite/agent-session-model-extension.test.ts`
- `packages/coding-agent/test/resident-console-command.test.ts`
- `packages/coding-agent/test/resident-console-client.test.ts`
- `packages/coding-agent/test/supervisor-resident-console.test.ts`
- `packages/coding-agent/test/deploy-resident-services.test.ts` — deployment mode selection and default systemd-unit cleanup.
- `packages/coding-agent/test/architect-service.test.ts` — explicit systemd rewrite/reload skip and lifecycle-action contract.

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
