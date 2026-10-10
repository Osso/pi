# Shared channel

Contract: [Shared channel](../../specs/shared-channel.md).

## Posting and storage

The channel is one global log in the [control DB](session-control-db.md), not a room or directed mailbox. [channel-post.ts](../../../packages/coding-agent/src/core/tools/channel-post.ts) defines the default-active tool registered by [tools/index.ts](../../../packages/coding-agent/src/core/tools/index.ts). It rejects child contexts and blank text, appends a trimmed body with sender identity, returns its numeric ID, and advances the sender cursor to that ID.

[session-control-db.ts](../../../packages/coding-agent/src/core/session-control-db.ts) stores `shared_channel_messages` (ID, sender session/agent, body, timestamp) and `shared_channel_cursors`, keyed by session ID and agent key. `cleanupExpiredMessages` deletes channel rows with `created_at` older than the 24h mailbox retention at open and on the 60s retained-connection timer; `AUTOINCREMENT` IDs are never reused, so cursors stay valid. A new cursor starts at the current tail. Updates use `MAX` to prevent backward movement. Advancing the sender to its new post also skips earlier unread entries for that sender; this is not a per-message self-echo acknowledgment.

## Recipient flow

[AgentSession](../../../packages/coding-agent/src/core/agent-session.ts) initializes the cursor when registering runtime coordination. A 30-second poll and runtime wake signal request drains. Child/inbound-disabled runtimes skip channel delivery; idle-triggered drains defer while streaming.

`readSharedChannelMessageSnapshot` captures the tail and reads every page up to it in ascending ID order. The drain removes self-origin and subagent-origin entries, combines remaining bodies through [runtime-coordination-format.ts](../../../packages/coding-agent/src/core/runtime-coordination-format.ts), then sends one custom follow-up with `customType: "shared_channel"`. It advances through the snapshot after delivery succeeds, or immediately when all entries were skipped. Failure leaves the batch unread. A wake during an in-progress drain sets a re-read flag rather than losing the wake.

Custom messages persist as `custom_message` entries, preserving classification and extension provenance rather than typed user history. Follow-up previews clear when the message starts. After successful delivery and cursor advancement, `onSharedChannelMessageDelivered` passes the exact formatted prompt to the wait wake callback wired in [main.ts](../../../packages/coding-agent/src/main.ts); [SDK documentation](../../../packages/coding-agent/docs/sdk.md#shared-channel-wait-wake-callback) describes that callback. Terminal notifications have priority when a wait sees both.

## Use and limits

Posting metadata requires a concrete coordination action naming the affected shared path/artifact; receive formatting prohibits acknowledgments and diagnostic echoes. These prose policies are not semantic validation of the body. Use directed mailbox messages for targeted coordination and [broadcast](session-directory-tools.md) for explicit forced delivery. There are no rooms, membership lists, or default child participation. Delivery/cursor writes are separate operations, not a transactional exactly-once transcript guarantee across a process crash.

## Evidence

Test source inspected, not run:

- [session-control-db.test.ts](../../../packages/coding-agent/test/session-control-db.test.ts), [runtime-coordination-format.test.ts](../../../packages/coding-agent/test/runtime-coordination-format.test.ts): cursor storage and sender/policy formatting.
- [runtime-mailbox.test.ts](../../../packages/coding-agent/test/runtime-mailbox.test.ts): 21-message pagination, batching/order, skipped senders, failed-batch retention, mid-drain wakes, and wait delivery.
- [agent-session-queue.test.ts](../../../packages/coding-agent/test/suite/agent-session-queue.test.ts), [shared-channel-end-turn-queue.test.ts](../../../packages/coding-agent/test/suite/regressions/shared-channel-end-turn-queue.test.ts): custom classification and preview removal.
- [headless-pi.test.ts](../../../packages/coding-agent/test/suite/headless-pi.test.ts): real-process custom-message persistence and signal-driven wait wake.
- [list-sessions-broadcast-tools.test.ts](../../../packages/coding-agent/test/list-sessions-broadcast-tools.test.ts): active registration, posting metadata, and child rejection.
