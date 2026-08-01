# Resident Supervisor service

The Supervisor runs as `pi supervisor` under `pi-supervisor.service`. It owns one archived SDK transcript using `openai-codex/gpt-5.6-sol` at low thinking effort. Unlike the Architect, it does not observe sessions periodically. Callers persist typed requests in `control.sqlite`; an owner-only Unix socket provides a wake notification, while SQLite remains the durable queue. The service claims one request, prompts the resident model, validates its JSON response, and persists the result for the waiting caller.

## Request flow

`supervisor_requests` stores request identity, sender session, canonical project family, request kind, bounded JSON evidence, original deadline, claim ownership, and typed response. Idle and completion goal requests carry the goal's ordered unconsumed `conversationEvents`; they no longer carry `terminalTurn`. After inserting a request, the caller sends a best-effort wake notification through the owner-only Unix socket. The Supervisor claims pending rows from SQLite at startup and after every wake, so a missed notification leaves the request durable for the next wake or service restart. Approval requests sort ahead of goal requests. If an approval arrives during a goal evaluation, the service aborts the model turn, requeues the unchanged goal request and its evidence, evaluates the approval, then later resumes the goal request within its original deadline.

Callers poll only their durable request row. Approval requests use a 30-second deadline; goal requests use three minutes. Approval failure escalates through the existing human reviewer. Goal failure keeps the goal running, displays an error, and does not continue automatically.

## Resident console

`pi --supervisor` attaches to the already-running `pi supervisor` process through the owner-only local socket `<control-db>.supervisor-console.sock`. It does not start a service, open the archived session itself, create another AgentSession, or change the Supervisor's KB cwd. If the service is stopped or the socket is absent, the client fails explicitly.

Attach returns the resident service name, session ID, fixed cwd, process generation, and the complete current branch. The client renders that snapshot, then receives monotonic live AgentSession events from the resident. The resident remains the only transcript writer, model caller, tool runner, and cwd owner. Exactly one console client is writable; a new attachment replaces and disconnects the previous client without replacing the resident session.

Console input is queued in the resident request loop. Durable approval and goal requests are claimed and completed first. A queued console prompt runs only after the current typed request finishes, so `readCurrentAssistantText()` cannot observe an unrelated assistant turn. A trailing message in `pi --supervisor <message...>` is submitted after attach; `pi --supervisor` opens the interactive console without an initial prompt. The existing `pi supervisor` service command is unchanged.

## Project memory

The caller resolves a canonical project family using `/syncthing/Sync/KB/memory/supervisor/projects.json`. Configured repository-root mappings take precedence, followed by configured owner/repository remote identities, the current remote repository basename, and finally the repository directory basename. Owner/repository identity prevents collisions such as the separate GlobalComix and MangaHelpers `ops` repositories.

The Supervisor starts with the configured KB as its working directory. Its only file tools are `read`, `edit`, and `write`; all normalize and resolve their target through existing symlinks before a tool gate permits access inside that KB root. Bash and Pyrun are unavailable. Its service-local approval policy is auto-approve because the KB-only gate is the file-access boundary and no human UI exists in the resident process. It receives no historical session transcript payload. Its prompt names `memory/supervisor/global.md` and the current project memory file so it can read or update them selectively.

## Approval integration

The `llm-approved-deny` and `llm-approved-ask` presets retain their user-facing identities. Their in-process auto-reviewer is removed. `AgentSession` submits `approval_review` with the current user request, tool name, tool call ID, normalized input, preset, and active goal JSON. `approve` allows execution; `reject` blocks under deny mode or opens native human review under ask mode; `error` always opens native human review when available.

## Goal integration

Explicit `manage_goal complete` requires a nonblank free-form Markdown
`completionReport`; missing or blank reports fail locally without creating a
Supervisor request. The request also carries all unconsumed ordered
`conversationEvents` for the active or explicitly paused goal. Valid reports are
sent verbatim in `goal_completion_review`, remain unchanged across wait/re-review,
and are persisted as `completionReason` only after a `complete` decision. Applied
`complete`, `continue`, `wait`, or `pause` decisions consume the events included in
that review. Supervisor instructions are not included because the resident
Supervisor already owns them in its persistent transcript. `continue` leaves the
goal running and queues a concrete next action. `complete` marks it complete.
`wait` appends durable Supervisor status, starts cancellable background `wait_agents`
when agents are active, and re-reviews after wake or after five minutes without
active agents, including when progress depends on an external condition that can be
rechecked. `pause` is reserved for required user action or input that cannot advance
automatically; it leaves the goal active without queueing another continuation. A
rejected report and the Supervisor's reason remain visible in durable status;
completion evidence is never inferred automatically.

Idle review remains inside the existing `agent_end` handler after its pending-message, abort, error-stop, and empty-response retry handling. Pending interactive input takes precedence over abort handling; a reviewed decision is retained if pending state drains without a turn. The request contains ordered unconsumed user text and successful `end_turn` reasons as `conversationEvents`; extension-generated messages and failed `end_turn` calls are excluded, and `terminalTurn` is not sent. This evidence is accumulated for running and explicitly paused goals, preserved through errors, stale decisions, and cancellation, and consumed only after an applied decision. Input, new turns, goal lifecycle changes, and shutdown cancel deferred decisions, wait operations, and timers. Goal identity is rechecked after asynchronous review before applying any decision. Scheduling and review failures append durable `supervisor-status` errors while leaving the goal active. A non-error empty assistant response schedules one continuation after a 1-second bounded delay only if the same goal remains active, the session is idle, and no messages are pending. `agent_end` already means the tool loop reached a terminal response with no further tool calls; no additional tool-call check exists or is needed. The previous unconditional continuation message is replaced by `goal_idle_review`.
