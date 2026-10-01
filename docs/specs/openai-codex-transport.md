# OpenAI Codex Responses transport

Module boundary: core AI provider adapter.

The OpenAI Codex Responses adapter supports explicit SSE and WebSocket transports. Requests that select WebSocket must remain on WebSocket for that attempt; SSE is used only when explicitly selected. Runtime details belong in [`docs/wiki/systems/openai-codex-transport.md`](../wiki/systems/openai-codex-transport.md).

## What it must do

### Transport selection

- [x] Use SSE only when `transport: "sse"` is explicitly selected.
- [x] Use WebSocket for `auto`, `websocket`, and `websocket-cached` transport modes.

### WebSocket failure behavior

- [x] Surface a WebSocket connect timeout without issuing an SSE request.
- [x] Surface a WebSocket idle timeout before the first event without issuing an SSE request.
- [x] Reconnect once over WebSocket when the backend reports its connection limit before output starts.
- [x] Preserve the original WebSocket failure in session debug statistics.

### Shared retry classification

- [x] Classify the exact transient Codex error `Unable to verify Daybreak Blue access. Please try again.` as retryable through the shared AI retry classifier.
- [x] Retain existing retry enablement, budget, and backoff; permanent access denial remains terminal. This classification neither switches providers nor bypasses access checks.

### Error support IDs

- Preserve an OpenAI server request ID from an HTTP error response or a streamed API `error` or `response.failed` event, including wrapped WebSocket events.
- Use available server `x-request-id` or `request_id` values and append `OpenAI request ID: <id>` to `AssistantMessage.errorMessage`.
- Do not present Pi session IDs or client request IDs as OpenAI server request IDs.
- Preserve the original error message when those error paths provide no server request ID.

## How it works

- [`docs/wiki/systems/openai-codex-transport.md`](../wiki/systems/openai-codex-transport.md)

## Implementation inventory

- `packages/ai/src/api/openai-codex-responses.ts` — selects the Codex transport and processes SSE or WebSocket streams.
- `packages/ai/src/types.ts` — defines shared stream transport options and retry events.
- `packages/ai/src/utils/retry.ts` — classifies shared AI transient errors, including the exact Codex access-verification error above.

## Tests asserting this spec

- `packages/ai/test/openai-codex-stream.test.ts`
- `packages/ai/test/openai-codex-request-id.test.ts`
- `packages/ai/test/retry.test.ts`
- `packages/coding-agent/test/suite/agent-session-daybreak-retry.test.ts`

## Known gaps (current cycle)

None.

## Out of scope

- Changing explicit SSE request, timeout, or retry behavior.
- Adding WebSocket retry policies beyond the existing connection-limit reconnect.
