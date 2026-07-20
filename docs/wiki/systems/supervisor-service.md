# Resident Supervisor service

The Supervisor runs as `pi supervisor` under `pi-supervisor.service`. It owns one archived SDK transcript using `openai-codex/gpt-5.6-sol` at low thinking effort. Unlike the Architect, it does not observe sessions periodically. Callers persist typed requests in `control.sqlite`; the service claims one request, prompts the resident model, validates its JSON response, and persists the result for the waiting caller.

## Request flow

`supervisor_requests` stores request identity, sender session, canonical project family, request kind, bounded JSON evidence, original deadline, claim ownership, and typed response. Approval requests sort ahead of goal requests. If an approval arrives during a goal evaluation, the service aborts the model turn, requeues the unchanged goal request, evaluates the approval, then later resumes the goal request within its original deadline.

Callers poll only their durable request row. Approval requests use a 30-second deadline; goal requests use three minutes. Approval failure escalates through the existing human reviewer. Goal failure keeps the goal running, displays an error, and does not continue automatically.

## Project memory

The caller resolves a canonical project family using `/syncthing/Sync/KB/memory/supervisor/projects.json`. Configured repository-root mappings take precedence, followed by configured owner/repository remote identities, the current remote repository basename, and finally the repository directory basename. Owner/repository identity prevents collisions such as the separate GlobalComix and MangaHelpers `ops` repositories.

The Supervisor starts with the configured KB as its working directory. Its only file tools are `read`, `edit`, and `write`; all normalize and resolve their target through existing symlinks before a tool gate permits access inside that KB root. Bash and Pyrun are unavailable. Its service-local approval policy is auto-approve because the KB-only gate is the file-access boundary and no human UI exists in the resident process. It receives no historical session transcript payload. Its prompt names `memory/supervisor/global.md` and the current project memory file so it can read or update them selectively.

## Approval integration

The `llm-approved-deny` and `llm-approved-ask` presets retain their user-facing identities. Their in-process auto-reviewer is removed. `AgentSession` submits `approval_review` with the current user request, tool name, tool call ID, normalized input, preset, and active goal JSON. `approve` allows execution; `reject` blocks under deny mode or opens native human review under ask mode; `error` always opens native human review when available.

## Goal integration

Explicit `manage_goal complete` requests `goal_completion_review` before changing goal state. `continue` leaves the goal running and queues a concrete next action. `complete` marks it complete. `wait` appends durable Supervisor status, starts cancellable background `wait_agents` when agents are active, and re-reviews after wake or after five minutes without active agents. `pause` leaves the goal active without queueing another continuation when progress requires user or external input.

Idle review remains inside the existing `agent_end` handler after its pending-message, abort, error-stop, and empty-response retry handling. Pending interactive input takes precedence over abort handling; a reviewed decision is retained if pending state drains without a turn. Input, new turns, goal lifecycle changes, and shutdown cancel deferred decisions, wait operations, and timers. Goal identity is rechecked after asynchronous review before applying any decision. Scheduling and review failures append durable `supervisor-status` errors while leaving the goal active. A non-error empty assistant response schedules one continuation after a 1-second bounded delay only if the same goal remains active, the session is idle, and no messages are pending. `agent_end` already means the tool loop reached a terminal response with no further tool calls; no additional tool-call check exists or is needed. The previous unconditional continuation message is replaced by `goal_idle_review`.
