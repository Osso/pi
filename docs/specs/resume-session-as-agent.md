# Resume Session as Agent

Resume Session as Agent lets a supervisor session attach an existing Pi session transcript as a child agent without changing that session's durable identity. The resumed session keeps its original `sessionId`, while the supervisor creates a separate `agentId` so the work can be listed, steered, waited on, cancelled, and reported through the normal multi-agent surfaces. Implementation details should live in [`docs/wiki/systems/resume-session-as-agent.md`](../wiki/systems/resume-session-as-agent.md) once the first slice lands.

## What it must do

### Identity and attachment

- [x] Attaching an existing session as an agent preserves the original session's `sessionId`.
- [x] Each attachment creates a distinct `agentId` owned by the supervisor's `MultiAgentStore` tree.
- [x] The created agent node records a transcript pointer for the resumed session, including session ID and session file path when available.
- [x] Attaching a session does not assume the previous Pi process or worker handle is still alive.
- [x] Viewing an attached session agent is read-only and must not resume, wake, cancel, or otherwise advance the session.

### Lifecycle and runtime behavior

- [x] A resume-as-agent request creates a normal child agent lifecycle record with revision-checked transitions.
- [x] Runtime launch/resume failures move the agent to `failed` with an inspectable error.
- [x] A successfully resumed session can reach terminal `completed`, `failed`, or `aborted` states through normal multi-agent lifecycle updates.
- [x] Cancelling the attached agent aborts the live resumed runtime when one exists and records terminal state through the same lifecycle path as spawned child agents.
- [ ] Reattaching a saved transcript after restart reconstructs only safe runtime handles and does not treat persisted metadata as proof of liveness.

### Mailbox and steering

- [x] Mailbox delivery to an attached session agent uses the preserved session identity plus the new agent identity as its runtime address.
- [x] Steering an attached session agent uses the existing safe checkpoint model: next model call, after tool result, or while waiting for input.
- [x] Completion and coordination messages from the attached agent return to the supervisor without requiring the supervisor to poll an external process manually.
- [x] Sender identity is derived from the active session/agent runtime; callers cannot spoof the resumed session as a mailbox sender.

### Permissions, account, and policy

- [x] Attaching a session as an agent inherits or narrows the supervisor's permission policy and must reject permission broadening.
- [x] Account/model/budget metadata for the attached agent follows the same inheritance rules as normal child agents unless the caller explicitly supplies a narrower supported override.
- [ ] A resumed session cannot use the attachment path to bypass project trust, tool approval, or filesystem permission checks.

### User-facing API

- [x] A first-party command or tool can attach/resume an existing session by session ID and optional prompt.
- [x] The attached session appears in existing agent listing/viewer surfaces with its agent ID, preserved session ID, lifecycle, revision, display name, and transcript pointer.
- [x] `wait_agent`, `cancel_agent`, `steer_agent`, `agent_viewer`, and mailbox tools work for attached session agents without special external-process handling by the caller.

## How it works

- [`docs/specs/multi-agent.md`](multi-agent.md) defines the authoritative lifecycle, mailbox, revision, permission, and projection contracts reused by this feature.
- [`docs/specs/session-lifecycle-hooks.md`](session-lifecycle-hooks.md) defines session resume/switch lifecycle events that attachment must respect.
- [`docs/specs/session-control-db.md`](session-control-db.md) defines the runtime control channel used by external process prompting and mailbox transport.
- [`docs/wiki/systems/resume-session-as-agent.md`](../wiki/systems/resume-session-as-agent.md) will describe the implementation once it exists.

## Implementation inventory

- `packages/coding-agent/src/core/multi-agent-store.ts` — owns agent node lifecycle, revisions, transcript metadata, mailbox state, and projections.
- `packages/coding-agent/extensions/agents-core/src/runtime.ts` — exposes attach/list/wait/cancel/steer runtime operations and child/attached session factory integration.
- `packages/coding-agent/extensions/agents-core/src/index.ts` — exports the attached-session factory and related types from the first-party agents-core package.
- `packages/coding-agent/src/main.ts` — wires production attached-session factories into first-party agents-core and Hostrun multi-agent registration.
- `packages/coding-agent/src/core/session-manager.ts` — owns persisted session metadata and session file resolution needed to find an existing transcript.
- `packages/coding-agent/src/core/agent-session.ts` — owns live agent runtime, explicit multi-agent identity, prompt processing, follow-up queues, tool approval, abort, and compaction behavior.
- `packages/coding-agent/src/core/session-control-db.ts` — owns the SQLite control channel and runtime mailbox primitives used for cross-session delivery.
- `packages/coding-agent/src/core/extensions/types.ts` — defines session lifecycle events, extension tool/command contracts, and explicit runtime agent identity on extension contexts.
- `packages/coding-agent/src/core/extensions/runner.ts` — carries explicit runtime agent identity into extension contexts.
- `packages/coding-agent/src/core/sdk.ts` — passes explicit runtime agent identity into created agent sessions.
- `packages/coding-agent/src/extensions/multi-agent.ts` — re-exports the multi-agent extension runtime and resume-session factory types.

## Tests asserting this spec

- `packages/coding-agent/test/multi-agent-store.test.ts`
- `packages/coding-agent/test/multi-agent-extension.test.ts`
- `packages/coding-agent/test/runtime-mailbox.test.ts`

## Known gaps (current cycle)

- [x] Add the first tests for preserving `sessionId` while creating a separate `agentId` during attachment.
- [x] Add a first attach/resume tool or command over an existing saved session.
- [x] Wire attached session lifecycle into existing `wait_agent`, `cancel_agent`, `steer_agent`, and viewer surfaces.
- [x] Verify completion notification for an attached session agent.
- [x] Verify permission inheritance/narrowing and rejection of permission broadening.

## Out of scope

- Merging two session transcripts into one durable session identity.
- Treating a persisted transcript as proof that an old runtime process is alive.
- Broadening permissions, project trust, or account capabilities while attaching a session.
- Retrofitting every historical `pi --session ... -p` invocation into an agent record.
