# JSON event stream

Module boundary: core CLI output projection.

`pi --mode json` emits a lean JSONL event stream for external consumers. Its print-mode source lives under `packages/coding-agent/src/modes/`; the exact wire shapes and migration are documented in the [JSON mode reference](../../packages/coding-agent/docs/json.md). Internal events remain unchanged. See the [implementation wiki](../wiki/README.md) for architecture documentation.

## What it must do

- [ ] Preserve the session header, event order, and existing fields except the explicitly removed body fields; introduce no replacement IDs, counters, or summaries.
- [ ] Emit `message_start.message` metadata without `content`, `details`, `summary`, `output`, `providerNative`, or `imageGenerationResult`.
- [ ] Emit updates without top-level `message` or nested `partial`; retain delta strings and indexes, omit `text_end`/`thinking_end.content`, `toolcall_end.toolCall`, and nested completed `message`/`error` bodies.
- [ ] Emit full completed messages only through `message_end`, preserving the existing event/message field order and all fields unchanged; retain `bash_messages_committed.messages` as the sole-body event for idle/deferred bash commits without message lifecycle emission.
- [ ] Omit `turn_end.message` and `turn_end.toolResults`; omit `agent_end.messages` while preserving `willRetry` and optional `sessionContinuation`.
- [ ] Remove only `tool_execution_end.result.content` and `.details`; retain metadata-only `result` including existing fields such as `terminate`, plus tool identity, timestamps, and error flag. Keep tool progress updates unchanged.
- [ ] Leave other session events and SDK/internal/TUI/RPC payloads unchanged; provide no compatibility mode for the old JSON wire shape.

## How it works

- [Wire projection and migration reference](../../packages/coding-agent/docs/json.md)
- [Implementation wiki index](../wiki/README.md)

## Implementation inventory

- `packages/coding-agent/src/modes/print-mode.ts` — JSON-mode subscription and line output.
- `packages/coding-agent/src/modes/json-event.ts` — JSON-only event projection.
- `packages/coding-agent/src/core/agent-session.ts` — internal session events consumed by the projection.
- `packages/agent-core/src/types.ts` — internal base event types.
- `packages/ai/src/types.ts` — assistant streaming event and message types.

## Tests asserting this spec

- `packages/coding-agent/test/print-mode.test.ts` — implementation-owned print-mode behavior tests; coverage and passing status not verified by this docs-only update.

## Known gaps (current cycle)

- [ ] Record verified behavioral coverage for each requirement after implementation validation; unchecked requirements are not claims of passing tests.

## Out of scope

- SDK, internal event, TUI, and RPC schema changes: this contract applies only to print-mode JSON serialization.
- Compatibility mode or alternate legacy wire output: explicitly excluded.
- Deployment and validation execution: handled outside this docs-only update.
