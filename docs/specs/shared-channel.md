# Shared channel

Module boundary: core built-in tool + session control DB + runtime coordination drain.

The shared channel is a single global append-only coordination log stored in `control.sqlite`.
Agents do not join rooms; each recipient tracks a cursor and drains unread messages while idle.
Implementation details may live in [`docs/wiki/systems/shared-channel.md`](../wiki/systems/shared-channel.md)
once needed.

## What it must do

### Storage

- [x] Store shared channel messages in `control.sqlite` as an append-only table.
- [x] Store recipient cursors keyed by `(session_id, agent_id_key)`.
- [x] New recipients initialize their cursor at the current tail to avoid historical floods.
- [x] Cursor advancement is monotonic and only moves forward.

### Delivery

- [x] Main-thread idle sessions drain messages with `id > cursor` from the shared channel.
- [x] Subagent sessions do not drain shared-channel messages by default.
- [x] Channel prompts are clearly tagged as shared-channel input and include sender session/agent.
- [x] The cursor advances after successful delivery.
- [x] Messages posted by the same recipient are skipped and marked seen to avoid self-echo.
- [x] Busy/streaming sessions do not drain channel messages until a later idle drain.

### Tool surface

- [x] `channel_post` is registered as a built-in tool and active by default.
- [x] `channel_post` appends one non-empty message to the shared channel.
- [x] `channel_post` is rejected from subagent contexts by default.
- [x] `channel_post` advances the sender cursor to the posted message so the sender does not receive its own post.

## How it works

- [`docs/specs/session-control-db.md`](session-control-db.md) owns the shared `control.sqlite` storage.
- [`docs/specs/multi-agent.md`](multi-agent.md) describes related runtime mailbox delivery; shared-channel delivery is separate and cursor-based.
- [`docs/specs/session-directory-tools.md`](session-directory-tools.md) covers `list_sessions` and `broadcast`, which remain diagnostic/force-message tools.

## Implementation inventory

- `packages/coding-agent/src/core/session-control-db.ts` — shared channel tables and cursor/message APIs.
- `packages/coding-agent/src/core/agent-session.ts` — idle drain integration and shared-channel prompt delivery.
- `packages/coding-agent/src/core/tools/channel-post.ts` — `channel_post` built-in tool.
- `packages/coding-agent/src/core/tools/index.ts` — built-in tool registration.

## Tests asserting this spec

- `packages/coding-agent/test/session-control-db.test.ts`
- `packages/coding-agent/test/runtime-mailbox.test.ts`
- `packages/coding-agent/test/list-sessions-broadcast-tools.test.ts`

## Known gaps (current cycle)

- [x] Add shared SQLite channel storage and cursors.
- [x] Add idle drain delivery.
- [x] Add `channel_post`.

## Out of scope

- Multiple named rooms/channels.
- Membership lists, join/leave, or per-room ACLs.
- Default subagent channel participation; subagents may get explicit opt-in later.
- Replacing `broadcast`; broadcast remains the explicit force-message path.
