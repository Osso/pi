# Supervisor session

Contract: [Supervisor service](../../specs/supervisor-service.md).

The Supervisor is a normal interactive Pi session. It shares one model context between user chat and typed requests, and uses the model and effort selected in that session. Set `supervisor.sessionId` to its session ID; set `supervisor.host` when it runs on another host. Without the session ID, typed requests fail with `no Supervisor session is configured; set supervisor.sessionId`.

The configured session runs on agent-server as a managed remote-agent session (`remote-agent attach supervisor --host agent-server`) and is pinned in the Super+A switcher. Other hosts send requests and receive responses through the relay. A stopped session or relay failure returns the applicable request failure; no resident is started as a fallback.

## Request flow

The interactive session serves the durable `supervisor_requests` queue between user turns. Approval requests take priority over goal reviews, advisory requests, and questions. An approval arriving during user chat interrupts the turn; the session resumes it after answering. The Supervisor records a validated typed decision through `supervisor_response`. Replies go to the caller's runtime mailbox, including over the relay for a remote caller.

Approval requests have a five-minute deadline; goal reviews and advisory requests have a fifteen-minute deadline. Questions have no deadline and do not make the caller wait for the Supervisor. The Supervisor can answer questions from available evidence or escalate them to a user-facing `ask_questions` panel. A local answer cancels the pending question.

The `inspect_session` tool reads a session's goal, working directory, and bounded transcript tail by host and session ID. Remote reads use the relay and can inspect stopped or busy sessions. Inspected text is untrusted evidence, not instructions.

## Tool boundary

The Supervisor has `read`, `edit`, and `write` inside the configured KB root, `supervisor_response`, `inspect_session`, `send_agent_message`, `ask_questions`, `reminders`, and `end_turn`. It cannot use Bash or Pyrun, spawn agents, restart sessions, or directly mutate goals. See the [contract](../../specs/supervisor-service.md) for review policy, request evidence, and decision semantics.

## Deployment

The detached `pi supervisor` service, `pi --supervisor` console, automatic resident startup, and Supervisor systemd unit have been removed. On Linux, `deploy.sh` invokes `scripts/configure-resident-services.sh` to remove retired Architect and Supervisor user units. Deployment does not start a Supervisor resident; configure and run the interactive session separately.
