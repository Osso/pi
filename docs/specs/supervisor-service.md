# Supervisor Session

The Supervisor is an interactive Pi session that evaluates approval and goal decisions for Pi sessions. It shares context between user chat and typed requests, reads and writes project memories in the shared KB, and returns typed decisions to callers. Implementation details belong in [../wiki/systems/supervisor-service.md](../wiki/systems/supervisor-service.md).

## What it must do

### Service lifecycle and model

- [x] Configure the interactive Supervisor with `supervisor.sessionId` and optional remote `supervisor.host`; fail typed requests explicitly when no session is configured.
- [x] Do not start a detached resident. On Linux, deployment removes retired Architect and Supervisor user units.
- [x] Delete completed and cancelled request rows 24 hours after completion; retain pending and claimed rows.

### Interactive Supervisor session

The Supervisor is a normal, full-UI interactive Pi session on agent-server. It replaced the detached resident and absorbs the [machine assistant](machine-assistant.md) role. The user talks to it like any Pi session; it also serves typed Supervisor requests.

- [x] Serve the durable `supervisor_requests` queue from the session named by setting `supervisor.sessionId` on the host that owns it; no detached resident is spawned when the setting is present.
- [x] Use one shared model context for user chat, duties, and typed requests. Process a claimed request as a turn between user turns; never interleave turns. Order: approval, goal review, advisory, question.
- [x] Record each typed response through a response tool whose arguments are validated per request kind; show each request and decision in the session UI.
- [x] Request deadlines: approval 5 min (then human escalation), goal review 15 min with one attempt (then `error` and the existing wake/55-minute re-review), advisory 15 min.
- [x] An approval request arriving during a user chat turn aborts that turn, is answered, and the aborted turn then continues.
- [x] The session uses the model and effort the user selects; no model is pinned.
- [x] Run as a managed remote-agent session on agent-server (`remote-agent attach supervisor --host agent-server`), pinned in the Super+A switcher.
- [x] Switch aso to the agent-server Supervisor after relay routing works; delete the detached resident (`pi supervisor`, `pi --supervisor`, autostart, systemd unit).
- [x] When the Supervisor session is down or the deadline passes, callers get the existing failure results; no fallback resident is started.
- [x] Use one transport for every kind: requests reach the queue through the relay from other hosts (phase 3), and every response is delivered to the asking session's runtime mailbox, through the relay for another host. Callers never read the queue row.
- [x] Approval, goal-review, and advisory callers wait for the correlated mailbox reply until their deadline; question callers do not wait.
- [x] A relay outage produces the same failure results as an unavailable Supervisor: a stopped local relay fails the request immediately, and a broken SSH link fails it at its deadline.
- [x] A request to a Supervisor session that is not running (locally, or as reported by the relay) stays queued and fails with the not-running reason only when no reply arrives within a three-minute restart grace, so a Supervisor restart does not fail requests.

### Question answering

Questions use the same queue and reply transport as other requests, with kind `question`. The only difference is that the asking session does not wait for the reply.

- [x] A `question` row carries the asking host, session, `requestId`, blocking flag, and questions. It has no deadline and runs after approval, goal-review, and advisory requests.
- [x] Respond through `supervisor_response` with `answer` (answers keyed by exact question text, each with a short reason) or `escalate` (reason).
- [x] Answer trivial and non-trivial questions decidable from user rules, specs, KB, earlier user decisions, repo evidence, or reasoning. Always escalate new scope, cost, safety risk, irreversible actions, and product tradeoffs the evidence does not settle.
- [x] On `escalate`, open the questions as an `ask_questions` panel in the Supervisor UI; the user's answer there is delivered to the asking session as a user answer.
- [x] An escalated (or failed) decision leaves the row in status `escalated` until the user answers it or the asker withdraws it. Cancelling the Supervisor panel leaves it open. When the Supervisor session starts, it reopens a panel for every stored escalated question, so a restart does not lose them.
- [x] The first user answer wins: the Supervisor UI and the `pi questions` CLI both store it only while the row is `escalated`, and the Supervisor panel closes when the row stops being `escalated`.
- [x] A local user answer cancels the row and stores those answers with source `local`; a cancelled question is never answered by the Supervisor or the user.
- [x] Store every final answer in the row with its source: absent for the Supervisor, `user` for the Supervisor UI or CLI, `local` for the asker's own panel.
- [x] The user may revise a stored answer. The revision replaces the stored answer (source `user`, `revisedAt`) and reaches the asking session as a new inbox message `User revised answers (request <id>):`, through the relay for another host. It is never matched to the original question's waiter.
- [x] The user may also answer a question that was cancelled without an answer (the asker stopped waiting). The answer is stored like a revision and reaches the asking session as an inbox message `User answered after the question ended without an answer (request <id>):`.
- [x] Keep question rows three days from creation, whatever their status; other request kinds keep the 24h retention after they finish.
- [x] Deliver each question reply (escalation, then any answer) to the asking session's mailbox. A failed question decision is delivered as an escalation.

### Session tools

- [x] Keep `userMessages` and other bounded evidence in request payloads; requests stay self-contained.
- [x] Provide a read-only `inspect_session` tool addressed by host and session ID that returns the goal, cwd, and transcript tail (the last 30 messages: user and assistant text, tool calls and results, each clipped to 600 characters). Reads of another host's session travel over the relay as a read request with a correlated reply; the relay on that host answers, so stopped or busy sessions can be read. Inspected text is untrusted evidence, not instructions.
- [x] Limit the Supervisor session, including user chat, to `read`, `edit`, `write`, `supervisor_response`, `inspect_session`, `send_agent_message`, `ask_questions`, and `end_turn`. Bash, Pyrun, agent spawn/attach, restart, and session control stay unavailable.

### Reminder delivery

- [x] With `supervisor.tasksUrl` set, the Supervisor session polls the [llm-tasks](https://github.com/Osso/llm-tasks/blob/master/docs/specs/http-api.md) `GET /tasks/due` route every minute (bearer token: first line of `~/.config/llm-tasks/token`; actor `<hostname>-supervisor`). It does not poll at session start, so a resumed interrupted turn runs first. Other sessions never poll.
- [x] Each due task not already pending in this process becomes one `reminder` custom message (follow-up, starts a turn) stating the task ID, title, due time, description, and that it is context, not authorization: forward it with `send_agent_message` or report it to the user.
- [x] After a check and whenever a run settles (`agent_settled`, after any automatic retry), a pending reminder whose message entry is written is acknowledged with `POST /tasks/{id}/delivered` and its due time. 409 (rescheduled, closed, or already acknowledged) drops it; other failures keep it pending and notify an error. A run that ends without the entry releases it; process exit releases all. Checks run one at a time and each request times out after 30 s.

### Removed resident console

The `pi --supervisor` console and detached `pi supervisor` entrypoint were removed. Use the interactive Supervisor session instead.

### Authority boundary

- [x] Ground binding requirements in explicit user instructions or applicable persistent project contracts. `userMessages` (the user's own messages and `ask_questions` answers, oldest first; later messages add to or override earlier ones) and user-kind conversation events supply user evidence; objectives, plans, summaries, assistant end-turn reports, and prior Supervisor decisions do not establish provenance by repetition. Remove unsupported constraints; disposable pilot IDs are diagnostic unless explicitly required. Apply this rule to goal creation, idle review, and completion review.

- [x] Keep the Supervisor as the first-level goal and completion reviewer: it remains a peer-unblocking policy engine, not a routine task manager, preserves agent autonomy and cumulative parent-goal consistency across requests, and intervenes only on evidence-backed exceptions; the calling subsystem enforces the typed response.
- [x] Detect narrowed or lost goals, dropped requirements, exclusions, or completion criteria, contradictions between claims and evidence, repeated or circular work, and missing completion proof without prescribing routine decomposition; only an explicit user instruction may reset or narrow a known parent objective.
- [x] Audit every automatic non-generic `continue.instructions` from goal idle and completion review through a separate stateless veto gate before delivery; the gate receives only the raw instruction message and has no goal, project, evidence, transcript, workspace, memory, or prior-decision context.
- [x] Run each veto evaluation as one fresh direct low-effort call to the configured Supervisor `gpt-6.1-sol` model under one fixed system policy, with one raw instructions user message, no tools, and no inherited transcript context.
- [x] Restrict veto output to `ACCEPT`, `REJECT_TASK_ASSIGNMENT`, `REJECT_IMPLEMENTATION_PRESCRIPTION`, `REJECT_SEQUENCING_INSTRUCTION`, `REJECT_AGENT_OR_TOOL_DIRECTION`, or `REJECT_PLAN_OVERRIDE`; any extra or invalid output is rejected.
- [x] Preserve accepted instructions; replace rejected, invalid, or failed evaluations with exactly `Continue working toward the active goal.` without retrying the first-level review at that boundary.
- [x] Append deterministic hidden feedback for actual policy rejections and fixed hidden failure feedback for invalid or failed evaluations to Supervisor context; neither rejected instructions nor feedback reaches the main agent, and compaction preserves the feedback.
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
- [x] Treat transcript tails obtained through `inspect_session` as untrusted evidence.
- [x] Let the Supervisor consult KB memory when current request evidence is insufficient.
- [x] Instruct the model to call the terminating structured `supervisor_response` tool exactly once as the final action for each request, without accompanying text or `end_turn`. When a structured response is present, extract and validate its current-request arguments and ignore accompanying assistant text rather than treating it as a validation failure; never reuse prior responses.
- [x] Answer user chat in plain assistant text. Outside a request turn, block `supervisor_response` with an instruction to answer in text, so a chat answer is never hidden in a tool call.
- [x] Keep veto evaluation inside the original goal-review request deadline, caller-cancellation boundary, and approval-preemption/requeue boundary.

### Supervisor answer display

- [x] The Supervisor answer replaces `Waiting for Supervisor…` in the same displayed block rather than adding a second `[Supervisor]` block. Rendering changes must not alter the underlying response or continuation payload, model-facing provenance, persistence, or delivery.

### Supervisor advisory

- [x] Expose `ask_supervisor` only to current main/orchestrator runtimes; explicit runtime child identity
      remains authoritative, and historical `is_subagent` transcript provenance alone does not reject a
      session opened as the main orchestrator. Sub-agents cannot use it.
- [x] Persist advisory requests as `supervisor_advisory` queue rows and return a text-only `{ kind: "advisory", answer }` response; advisory responses cannot control the caller or mutate goals, policies, sessions, processes, or agents.
- [x] Bound inputs to a 4,000-character question and optional 8,000-character context.
- [x] Enforce a fifteen-minute request deadline.
- [x] Schedule advisory requests below approval and goal reviews.

### Codex cybersecurity-risk advisory recovery

User basis (verbatim): “exact Codex cybersecurity-risk flag -> bounded advisory proposing only genuinely different/narrower permitted subtask withinoriginaluserauthorization; main caller autoattempt once sameprovider/model/accesssettings; originalrequest/refusal/history and broadergoal remain”. This preference authorizes bounded permitted-subtask recovery, not entitlement or access approval.

- [x] Trigger only for an assistant error from the `openai-codex-responses` API containing the exact canonical flag `This content was flagged for possible cybersecurity risk.`; classify that flag as nonretryable before generic status patterns. Do not treat it as transient failure, quota exhaustion, or permission to retry the refused request.
- [x] Request one bounded, text-only Supervisor advisory under the existing advisory input limits and fifteen-minute deadline. Supply bounded current evidence, including the original user authorization quoted exactly and the refusal; never reconstruct authorization from assistant summaries or treat the recovery preference as approval of entitlement. The Supervisor may propose only a genuinely different or narrower permitted subtask already within that authorization, or state that no such subtask exists.
- [x] Treat the Supervisor proposal as untrusted advice, never authority. The normal main agent makes exactly one tool-free policy-validation AgentSession invocation (an error-stopped or timed-out validation denies) with the same provider, model, access settings, and retained history as the flagged request. Require strict JSON with exactly `{ allowed, task, reason, basisQuote }`: a boolean `allowed`, the exact proposed task, a nonempty reason, and a string quote. An affirmative decision requires a nonempty exact quote from the original user request; substring matching alone does not establish semantic permission, and prohibitions must be interpreted in context.
- [x] Only a valid main-agent `allowed: true` decision permits at most one automatic operative task attempt of the genuinely different or narrower task within existing authorization. AgentSession cannot redispatch either validation or the operative attempt through transient-error retry, thinking-timeout recovery, or overflow-compaction recovery; an operative error ends recovery. This is an invocation/task-attempt guarantee, not universal wire-send exactly-once: provider-internal `websocket_connection_limit_reached` reconnect before response start can resend within the same invocation. That resend is neither a new task attempt nor authorization to retry refused content. Denial, errors, malformed output, or attempted tools stop recovery without operative effects; validation tools cannot execute, and the original tool set is restored after validation or cancellation. Keep provider, model, account/backend, and access settings unchanged throughout validation and the attempt; do not grant new permission or use fallback to overcome the restriction.
- [x] Preserve the original request, refusal, and history as evidence and keep the broader goal, requirements, exclusions, and completion criteria intact. Identify the attempted subtask and advisory provenance visibly; do not camouflage the refused operation, conceal intent, or merely rephrase it to evade the restriction. Do not change permissions, access tier, account, backend, provider, or model to overcome the flag.
- [x] Atomically claim the recovery budget in the control SQLite database by the explicit user-request UUID, outside transcript branch state. Rewind, fork, restart, cancellation, duplicate delivery, extension-generated continuation, or a repeated flag cannot replenish it. Only new actual human input with a new request UUID receives a new budget; restoring interrupted or uncertain recovery must not replay it automatically.
- [x] Cancel recovery on meaningful context, model, or goal changes, new input, or caller cancellation; late or stale advice and validation cannot dispatch work. Harmless Supervisor status messages do not invalidate pending recovery.
- [x] Tag validation `agent_end` with `sessionContinuation: "codex_restriction_validation"` so review JSON cannot trigger goal completion or ordinary continuation. Report `willRetry` truthfully: validation is not an operative retry, and denial, invalid output, or cancellation cannot promise an attempt.
- [x] If no allowed subset exists, policy validation fails, the attempt is flagged again after the request's recovery was used, or the advisory is unavailable, invalid, or times out, stop that recovery attempt and surface the reason and required user action (send a new request) without automatically retrying or escalating access. Caller cancellation, new input, or a context change stops recovery silently, since the user's own action caused it. The blocked attempt neither completes nor replaces the broader goal.
- [ ] Continue independent already-authorized work when possible without pausing unrelated work; automatic scheduling of unrelated tasks remains outside the supplied recovery proof.

Proof boundary: the supplied current results are 23 unit tests (including session and extension `agent_end` continuation/`willRetry` events, timeout tool restoration, and normal new-request retries after operative timeout/abort) and 13 real-process cases using controlled responses. They establish local validation enforcement, preserved evidence/settings/goals, cancellation, and durable budget behavior, not real-provider semantic classification or guaranteed avoidance of another flag. Independent already-authorized work remains in scope; these tests do not prove automatic scheduling of every unrelated task.

### Approval review

- [x] Replace the existing LLM auto-reviewer with a Supervisor `approval_review` request while preserving the surrounding approval orchestrator and human-review paths.
- [x] Auto-approve inherently read-only built-in tools (`read`, `grep`, `find`, `ls`, `outline`, `symbol`, and `references`) after extension and permission hooks have had an opportunity to deny them, without consulting the Supervisor or prompting the user.
- [x] Include the tool name, normalized arguments, current user request, active running goal when present, and applicable preclassified approval rules in the request evidence.
- [x] Return exactly `approve`, `reject`, or generic `error` for approval review.
- [x] Enforce a five-minute deadline that includes model work plus synchronous KB reads and writes.
- [x] Escalate `error`, timeout, invalid response, or unavailable Supervisor to human review.

### Goal completion review

- [x] Intercept `manage_goal complete` before the calling session marks the running goal complete.
- [x] Send a `goal_completion_review` request containing the objective and the caller-provided completionReport verbatim; later wait wakeups preserve that report and add bounded wake evidence.
- [x] Include all unconsumed ordered `conversationEvents` in idle and completion goal reviews, preserve them across failed, stale, or canceled reviews, and consume them only after applying `complete`, `continue`, `wait`, or `pause`.
- [x] Return exactly `complete`, `continue`, `wait`, `pause`, or generic `error` for goal completion review.
- [x] Mark the goal complete only when the caller receives `complete`, persisting the verbatim completionReport as completionReason.
- [x] Clear stored goal-review conversation evidence when completion is applied.
- [x] Keep the goal running when the caller receives `continue`; use exactly `Continue working toward the active goal.` when the agent can continue autonomously, and reserve specific Supervisor instructions for an evidence-backed omission, repeated failed or circular work, lost objective scope, or missing completion proof, naming only the exception and smallest corrective action.
- [x] Audit every non-generic completion-review `continue.instructions` through the stateless veto gate before delivery; accepted instructions are preserved, while rejected, invalid, or failed evaluations use the exact generic continuation and do not retry the first-level review at that boundary.
- [x] On `wait`, append one durable Supervisor status entry with one absolute fifty-five-minute `reviewAt` deadline, regardless of whether agents are active; active-agent mode starts a cancellable background `wait_agent`, agent completion reviews early, deadline expiry cancels `wait_agent` and reviews, the first path wins without duplicate review, and `wait_agent` failure retains the original deadline for timed review.
- [x] On `error`, append durable status and keep the completion request unresolved without scheduling automatic re-review; rejected completion reports remain visible with the Supervisor's reason in durable status.
- [x] Leave the goal active without another continuation only when required user action or input is needed and no automatic recheck can advance progress; the caller receives `pause` only for that manual stop condition.
- [x] Treat supplied objectives and current progress claims as claims about the active goal; preserve the grounded unfinished parent objective when judging completion, excluding unsupported additions repeated in Supervisor context or KB memory, so a child slice cannot replace the broader objective.
- [x] Require the Supervisor to make its best judgment between `complete`, autonomous or corrective `continue`, scheduled `wait` only when a pending asynchronous result or recheckable external condition blocks all remaining goal work, including when the only remaining work needs that result (a running suite, build, agent, or external job never justifies `wait` while other authorized goal work can proceed without it), and manual-only `pause` from the supplied report; uncertainty alone uses generic continuation rather than invented oversight, the caller must provide a nonblank report, and the system never infers completion evidence automatically.

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
- [x] Audit every non-generic idle-review `continue.instructions` through the stateless veto gate before delivery; accepted instructions are preserved, while rejected, invalid, or failed evaluations use the exact generic continuation and do not retry the first-level review at that boundary.
- [x] Keep the goal active on `wait`, append one durable status entry with one absolute fifty-five-minute `reviewAt`, and re-run review after the first agent wake or deadline, including for external conditions that can be rechecked; cancel the losing wake path and never schedule duplicate review work.
- [x] Leave the goal active without another continuation when the caller receives `pause` because required user action or input is needed and no automatic recheck can advance progress.
- [x] Preserve the cumulative unfinished parent objective throughout continuation review; a bounded request or current subtask never replaces remaining requirements, exclusions, or completion criteria.
- [x] Require best judgment between `complete`, autonomous or corrective `continue`, scheduled `wait` only when a pending asynchronous result or recheckable external condition blocks all remaining goal work, including when the only remaining work needs that result (a running suite, build, agent, or external job never justifies `wait` while other authorized goal work can proceed without it), and manual-only `pause`; do not restate plans, prescribe routine steps, or invent oversight when the agent can determine how to continue.
- [x] On goal `error`, keep the goal running, append visible durable error status without requiring human approval, and use the same agent-wake or fifty-five-minute re-review path as `wait`; rejected scheduled work remains visibly durable.
- [x] Retry before review when pending input is transient, preserve reviewed decisions when input becomes pending during review, and cancel in-flight reviews, deferred decisions, waits, discovery calls, and timers on input, new turns, goal lifecycle changes, and shutdown; recheck cancellation generation and goal identity before applying an asynchronous decision.
- [x] Enforce a fifteen-minute deadline for goal reviews.

### Scheduling and preemption

- [x] Give approval reviews priority over goal reviews and memory work.
- [x] Abort and requeue an active goal review when an approval request arrives.
- [x] Preserve the original goal request evidence when requeuing it.
- [x] Process the approval immediately after preemption.
- [x] Keep the requeued goal review within its original fifteen-minute request deadline.

### Failure handling

- [x] Caller cancellation stops polling and retries, atomically moves a sender-owned pending or claimed request to terminal `cancelled`, wakes the Supervisor session, aborts active evaluation, and prevents later claim or completion.
- [x] Interactive Escape reaches an active goal review through global input even when the caller is idle (the editor keeps focus while the waiting status shows), then clears the loader without applying a stale decision.
- [x] Return generic `error` for service, transport, timeout, model, tool, or response-validation failures; include the current model response's error detail when available without reusing an earlier response.
- [x] Fail non-generic instruction vetoes closed: invalid output or evaluation failure suppresses the proposed instruction, appends fixed hidden failure feedback, and delivers exactly the generic continuation without retrying the first-level review at that boundary.
- [x] Make one attempt per request; a timeout returns generic `error` without retry.
- [x] Fail approval reviews to human escalation.
- [x] Fail goal reviews visibly without completing the goal or invoking human approval; idle-review errors enter bounded wake/re-review scheduling, while completion-review errors remain unresolved until another explicit completion attempt.

## How it works

- [x] See [`docs/wiki/systems/supervisor-service.md`](../wiki/systems/supervisor-service.md).
- [x] Integrates with [`approval-system.md`](approval-system.md).
- [x] Integrates with [`goal-system.md`](goal-system.md).
- [x] Uses an interactive session rather than the Architect resident lifecycle.

## Implementation inventory

- `packages/coding-agent/extensions/supervisor-session/src/index.ts` — interactive Supervisor session: queue serving between user turns, visible request turns ending in `supervisor_response`, approval preemption of user turns with resumption, tool allow-list with KB-only file access.
- `packages/coding-agent/src/supervisor/question-answers.ts` — user answers and revisions of stored questions (Supervisor UI and `pi questions`), with their mailbox replies and corrections.
- `packages/coding-agent/src/supervisor/ensure-running.ts` `ensureSupervisorAvailable` — reports a configured Supervisor session that is not running as `SupervisorNotRunningError`; fails explicitly when `supervisor.sessionId` is unset.
- `packages/coding-agent/src/supervisor/service.ts` — bounded prompts, typed response validation, veto tokens and policy contract, deadlines, approval preemption, and active-evaluation cancellation.
- `packages/coding-agent/src/supervisor/client.ts` — checks session availability, performs durable synchronous caller transport, and propagates caller cancellation.
- `packages/coding-agent/src/supervisor/ensure-running.ts` — checks the configured session address and availability.
- `packages/coding-agent/src/supervisor/project-resolver.ts` — KB config loading and canonical project-family resolution.
- `packages/coding-agent/src/supervisor/approval-reviewer.ts` — approval decision enforcement and human escalation.
- `packages/coding-agent/src/core/session-control-db/supervisor.ts` — durable `supervisor_requests` repository.
- `packages/coding-agent/src/core/tools/ask-supervisor.ts` — main-session-only bounded advisory tool.
- `packages/coding-agent/src/core/agent-session.ts` / `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — active-review cancellation registration and global Escape routing.
- `packages/coding-agent/extensions/goal/src/index.ts` — completion and existing `agent_end` continuation gates.
- `packages/coding-agent/extensions/goal/src/goal-review-evidence.ts` — supplies ordered unconsumed conversation events to goal reviews and consumes them after applied decisions.
- `packages/coding-agent/extensions/goal/src/goal-scheduling.ts` — cancellable agent waits, pending-decision handoff, timed review, identity rechecks, and visible scheduling failures.
- `packages/coding-agent/extensions/goal/src/rendering.ts` — durable Supervisor status entries and tagged continuation rendering.
- `scripts/configure-resident-services.sh` — cleanup of retired Architect and Supervisor user units.

## Tests asserting this spec

- `packages/coding-agent/test/suite/supervisor-due-tasks.test.ts` — due llm-tasks reminders delivered once and acknowledged with their due time after the entry is written, 409 acknowledgement dropped without retry, no polling outside the Supervisor session or without `supervisor.tasksUrl`.
- `packages/coding-agent/test/suite/supervisor-session.test.ts` — typed response recording, missing-response error, approval interrupting and resuming a user turn, tool allow-list and KB-only writes, other sessions unaffected.
- `packages/coding-agent/test/suite/supervisor-questions.test.ts` — Supervisor answer closes the asker's panel with reasons, local answer cancels the row, escalation opens a Supervisor panel whose answer returns as a user answer, nonblocking answers arrive through the inbox, a stored escalation reopens when the Supervisor session starts, a CLI answer closes the Supervisor panel, and a revision arrives as a correction.
- `packages/coding-agent/test/supervisor-question-store.test.ts` — escalated status and first-answer-wins, stored local answers, revision rules, three-day question retention.
- `packages/coding-agent/test/suite/headless-supervisor-session.test.ts` — real Pi process serves queued requests and reruns a claimed request after restart.
- `packages/coding-agent/test/supervisor-ensure-running.test.ts` — reports a down configured session without resident startup.
- `packages/coding-agent/test/provider-restriction-recovery.test.ts` — bounded advisory evidence and strict, fail-closed main-validation response parsing.
- `packages/coding-agent/test/suite/agent-session-codex-restriction-recovery.test.ts` — main validation, denied/tool-call no-operation behavior, restored tools, and harmless-status handling.
- `packages/coding-agent/test/suite/headless-codex-restriction-recovery.test.ts` — controlled real-process recovery, goal/evidence/settings preservation, live-child cancellation, stale advice, restart, rewind/fork budgets, and main denial of a prohibited proposal.
- `packages/coding-agent/test/supervisor-request-repository.test.ts`
- `packages/coding-agent/test/supervisor-project-resolver.test.ts`
- `packages/coding-agent/test/supervisor-client.test.ts`
- `packages/coding-agent/test/supervisor-ensure-running.test.ts`
- `packages/coding-agent/test/supervisor-service.test.ts` — advisory response contract, validation, and claimed-request evaluation cancellation.
- `packages/coding-agent/test/supervisor-structured-response.test.ts` — structured response decisions with accompanying assistant text, conflicting text, and invalid response kinds.
- `packages/coding-agent/test/supervisor-instruction-veto.test.ts` — stateless veto classification, closed output, fail-closed replacement, hidden feedback, compaction preservation, and approval preemption during veto evaluation.
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
- `packages/coding-agent/test/deploy-resident-services.test.ts` — retired systemd-unit cleanup.
- `packages/coding-agent/test/architect-service.test.ts` — retained Architect lifecycle behavior.

## Known gaps (current cycle)

- [x] Integrate bounded Codex restriction recovery and prove local enforcement with supplied 17-unit/13-process results, including restart, cancellation, stale-result fencing, and one-attempt preservation across rewind/fork.
- [ ] Add dedicated assertions for validation `agent_end` tagging and truthful `willRetry` lifecycle behavior; implemented tagging is not itself event-level proof.
- [ ] Real-provider semantic classification remains unverified; controlled-response tests do not establish that any proposed task will avoid the provider flag.

- [x] Define and test the typed Supervisor request and response protocol.
- [x] Implement the persistent request/response repository with priority and preemption semantics.
- [x] Implement the interactive Supervisor session and restricted tool boundary.
- [x] Implement KB-backed canonical project resolution and memory access.
- [x] Replace the approval auto-reviewer call with `approval_review`.
- [x] Gate explicit goal completion with `goal_completion_review`.
- [x] Replace the existing `agent_end` continuation decision with `goal_idle_review` without changing its trigger or guards.
- [x] Remove the detached Supervisor service and systemd unit.

## Out of scope

- Cross-session work coordination, checkout ownership, duplicate-work detection, or incompatible-goal detection.
- Goal merging, broader orchestration, or any change to first-level goal/completion review authority; the veto gate only filters automatic continuation instructions.
- Full historical transcript delivery; bounded tails are available through `inspect_session`.
- Automatic web research.
- Workspace mutation, autonomous remediation, agent dispatch, or direct session/goal mutation by the Supervisor.
- Separate models for approvals and goals.
