# Model-request extension events

[Contract](../../specs/model-request-extension-events.md)

## Event boundary

Extensions subscribe with `pi.on("model_request_start", handler)` and `pi.on("model_request_end", handler)`. Public events in [`extensions/types.ts`](../../../packages/coding-agent/src/core/extensions/types.ts) carry only their `type`; there is no request ID, timestamp, usage or outcome field. See [extension author documentation](../../../packages/coding-agent/docs/extensions.md).

[`agent-loop.ts`](../../../packages/agent-core/src/agent-loop.ts) emits start immediately before `streamAssistantResponse()` and end in its `finally`. Assistant start/update/end events lie inside the pair; tool execution follows it. Failed/aborted requests therefore still produce an end event. [`agent-session.ts`](../../../packages/coding-agent/src/core/agent-session.ts) awaits forwarding to the extension runner.

These measure foreground request lifecycle, not each HTTP retry attempt or all model work performed elsewhere. Handlers needing duration record their own clock; the observed wall span can include runtime/context processing and extension overhead, not just network streaming.

## TPS consumer

[`.pi/extensions/tps.ts`](../../../.pi/extensions/tps.ts) starts request timing at start, captures the first generated content delta for TTFT, collects assistant output usage, and closes the span at end. Headline TPS divides generated output tokens by the sum of complete request durations, including TTFT. It reports `n/a` when a meaningful rate is unavailable, not a decode-only rate.

Tool spans are unioned to avoid double-counting parallel work; `loop` spans agent start through end and remains the total user-visible duration. This consumer is a project extension, not an extra field added to request events.

## Test evidence and limits

Inspected, not run: [`model-request-extension-events.test.ts`](../../../packages/coding-agent/test/suite/model-request-extension-events.test.ts) asserts ordering and matching end events on failure/abort. [`.pi/tests/tps.test.ts`](../../../.pi/tests/tps.test.ts) asserts full-request throughput, overlapping tools and event wiring. These do not establish provider-internal retry timing or live-provider performance; no such requirement is implemented by this event pair.
