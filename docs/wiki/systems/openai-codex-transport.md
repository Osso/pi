# OpenAI Codex Responses transport

[Contract](../../specs/openai-codex-transport.md)

## Transport and failure flow

[`openai-codex-responses.ts`](../../../packages/ai/src/api/openai-codex-responses.ts) builds the provider payload, applies `onPayload`, derives account/auth headers and selects transport. Only explicit `transport: "sse"` enters HTTP/SSE. Omitted transport defaults to `auto`; `auto`, `websocket` and `websocket-cached` use WebSocket. Options are declared in [`types.ts`](../../../packages/ai/src/types.ts).

WebSocket success finalizes the shared assistant stream. Connect/idle timeout or transport failure is surfaced, recorded in session WebSocket statistics and attached as a transport diagnostic where applicable; no SSE request follows. Backend `websocket_connection_limit_reached` may reconnect once before output starts, unless aborted. The second failure is terminal for that attempt. API/protocol failures retain their original error rather than being disguised as transport failures.

`auto` and `websocket-cached` enable cached-context handling; plain `websocket` does not. Explicit SSE uses its own HTTP retry path and can zstd-compress the request body when runtime support permits. Both transports feed the shared response-event normalization.

## Support IDs and retry classification

HTTP errors prefer server `x-request-id`, then parsed body `request_id`. Streamed `error`/`response.failed` events inspect server header and event/nested response IDs, including WebSocket envelopes. Available IDs append `OpenAI request ID: …` to the error message. Client request/session IDs and response object `id` are not substitutes; absent server IDs leave the original message intact.

[`retry.ts`](../../../packages/ai/src/utils/retry.ts) recognizes the exact `Codex error: Unable to verify Daybreak Blue access. Please try again.` message, optionally followed by its support ID. That classification uses existing session retry enablement, budget and backoff; it neither changes transport/provider nor retries known permanent errors.

The reported runtime handshake error, `WebSocket connection to 'wss://chatgpt.com/backend-api/codex/responses' failed: Expected 101 status code`, is covered by a narrow shared-classifier change. It uses those same session retries, not a new provider retry loop or SSE fallback. The message hides the actual HTTP rejection reason; bounded retry does not guarantee recovery.

## Test evidence and limits

[`openai-codex-stream.test.ts`](../../../packages/ai/test/openai-codex-stream.test.ts) contains mocked SSE/WebSocket streaming, timeout, connection-limit reconnect and cached-context scenarios. [`openai-codex-request-id.test.ts`](../../../packages/ai/test/openai-codex-request-id.test.ts) covers server IDs and pre-open handshake error preservation without SSE fallback. [`retry.test.ts`](../../../packages/ai/test/retry.test.ts) and [`agent-session-daybreak-retry.test.ts`](../../../packages/coding-agent/test/suite/agent-session-daybreak-retry.test.ts) cover classification, recovery, budget exhaustion, disabled retries, cancellation and permanent denial. Mocked sockets and faux-provider sessions are not live-backend acceptance evidence.
