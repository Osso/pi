# JSON Event Stream Mode

```bash
pi --mode json "Your prompt"
```

Outputs session events as JSON lines to stdout, with lean message and lifecycle payloads. This is a wire projection, not a serialization of the internal `AgentSessionEvent` type. SDK subscriptions, internal events, the TUI, and RPC retain their existing payloads.

## Output Format

Each line is a JSON object. The first line is the session header:

```json
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}
```

Subsequent lines preserve event order. Projection removes the fields listed below; it does not introduce replacement IDs, counters, or summary fields. All other existing fields remain unchanged. Undefined optional fields are omitted by JSON serialization.

## Wire Contract

### Message events

| Event | JSON payload |
|---|---|
| `message_start` | Keeps `message` metadata, removing `content`, `details`, `summary`, `output`, `providerNative`, and `imageGenerationResult`. Other message fields and event-level metadata remain. |
| `message_update` | No top-level `message`. Keeps `assistantMessageEvent` without `partial` or completed body fields (`content`, `toolCall`, `message`, `error`). Existing event-level metadata remains. |
| `message_end` | Full completed `message`, unchanged. The event and message preserve their existing field order; no message reconstruction or reordering occurs. |

The nested `assistantMessageEvent` wire shapes are:

```typescript
type JsonAssistantMessageEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number }
  | { type: "toolcall_start"; contentIndex: number }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number }
  | { type: "done"; reason: "stop" | "length" | "toolUse" }
  | { type: "error"; reason: "aborted" | "error" };
```

These shapes describe projection when a nested event is emitted, not a guarantee that every variant appears in each run. Text/thinking end markers do not repeat `content`; tool-call end markers do not repeat `toolCall`. Deltas retain their original strings and content indexes.

### Lifecycle and tool events

| Event | JSON payload |
|---|---|
| `turn_end` | No `message` or `toolResults`; other existing fields remain. |
| `agent_end` | No `messages`; keeps `willRetry` and optional `sessionContinuation` unchanged. |
| `tool_execution_start` | Unchanged: `toolCallId`, `toolName`, `args`, `startedAt`. |
| `tool_execution_update` | Unchanged: `toolCallId`, `toolName`, `args`, `partialResult`. Progress payloads are not stripped. |
| `tool_execution_end` | Keeps metadata-only `result`: removes `result.content` and `result.details`, retaining other existing result fields such as `terminate` (or `{}` when none remain). Keeps `toolCallId`, `toolName`, `isError`, `startedAt`, and `finishedAt`. |

Read completed user, assistant, and tool-result messages from `message_end`, not lifecycle markers. `bash_messages_committed` is the retained sole-body event for idle or deferred bash messages committed to session state; its `messages` payload remains unchanged because those bodies have no corresponding message lifecycle emission.

Other session events remain unchanged, including queue, compaction, and retry events. `queue_update` carries full pending steering and follow-up queues. Compaction events retain their existing result and status payloads.

## Migration (Breaking Change)

There is no compatibility mode for the former snapshot-heavy JSON stream. Consumers must stop reading accumulated messages from updates, completed block bodies from end markers, message bodies from `message_start`, transcripts from `agent_end`, turn results from `turn_end`, or final result bodies from `tool_execution_end`. Its metadata-only `result` still carries fields such as `terminate` that have no message equivalent.

For live display, consume deltas and unchanged tool progress updates. For authoritative completed messages, consume `message_end`; for committed bash bodies, consume `bash_messages_committed`. Preserve retry/continuation handling from `agent_end`. SDK/internal/TUI/RPC consumers require no migration.

## Message Types

Completed messages retain the existing types defined in [`packages/ai/src/types.ts`](../../ai/src/types.ts) and [`core/messages.ts`](../src/core/messages.ts): user, assistant, tool result, bash execution, custom, branch summary, and compaction summary messages. Message metadata is role-dependent, not a new fixed schema.

## Example

A schematic stream (metadata abbreviated in prose, not extra wire fields):

```json
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","timestamp":0}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":0}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}],"timestamp":0}}
{"type":"turn_end"}
{"type":"agent_end","willRetry":false}
```

The illustrative assistant message omits provider/model/usage metadata; real `message_end` output preserves all existing fields and their order.

```bash
pi --mode json "List files" 2>/dev/null | jq -c 'select(.type == "message_end")'
```

See the tracked [JSON event-stream spec](../../../docs/specs/json-event-stream.md).
