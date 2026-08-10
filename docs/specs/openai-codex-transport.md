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

## How it works

- [`docs/wiki/systems/openai-codex-transport.md`](../wiki/systems/openai-codex-transport.md)

## Implementation inventory

- `packages/ai/src/api/openai-codex-responses.ts` — selects the Codex transport and processes SSE or WebSocket streams.
- `packages/ai/src/types.ts` — defines shared stream transport options and retry events.

## Tests asserting this spec

- `packages/ai/test/openai-codex-stream.test.ts`

## Known gaps (current cycle)

None.

## Out of scope

- Changing explicit SSE request, timeout, or retry behavior.
- Adding WebSocket retry policies beyond the existing connection-limit reconnect.
