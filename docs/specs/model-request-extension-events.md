# Model Request Extension Events

Model-request lifecycle events let extensions observe each foreground model request independently of tool execution. The contract is exposed through `ExtensionAPI` and emitted by the coding-agent runtime. The TPS extension consumes these events to report complete foreground request throughput. How the runtime emits the events belongs in `docs/wiki/systems/model-request-extension-events.md`.

## What it must do

### Extension API

- [x] `ExtensionAPI.on("model_request_start", handler)` is available to extensions.
- [x] `ExtensionAPI.on("model_request_end", handler)` is available to extensions.
- [x] A foreground model request emits `model_request_start` before assistant message events and `model_request_end` after them (`packages/coding-agent/test/suite/model-request-extension-events.test.ts`).
- [x] Failed and aborted foreground model requests emit the matching end event (`packages/coding-agent/test/suite/model-request-extension-events.test.ts`).

### TPS instrumentation

- [x] Headline `TPS` reports generated output tokens over complete foreground model-request wall time, including TTFT (`.pi/tests/tps.test.ts`).
- [x] TPS output does not report a decode-only rate (`.pi/tests/tps.test.ts`).
- [x] `loop` remains the total user-visible agent-loop wall time (`.pi/tests/tps.test.ts`).

## How it works

- See `docs/wiki/systems/model-request-extension-events.md` (stub).
- Extension author documentation: `packages/coding-agent/docs/extensions.md` — Agent Events and lifecycle overview.

## Implementation inventory

- `packages/coding-agent/src/core/extensions/types.ts` — public event types and `ExtensionAPI.on(...)` overloads.
- `packages/coding-agent/src/core/agent-session.ts` — forwards model-request lifecycle events to extensions.
- `packages/agent-core/src/agent-loop.ts` — emits model-request lifecycle events around foreground requests.
- `.pi/extensions/tps.ts` — records complete foreground request spans and formats TPS output.

## Tests asserting this spec

- `packages/coding-agent/test/suite/model-request-extension-events.test.ts`
- `.pi/tests/tps.test.ts`

## Known gaps (current cycle)

None.

## Out of scope

- Provider-internal retry attempt events and timing.
- Tool execution timing, except where the TPS display separates it from model-request time.
- Decode-only throughput as a headline metric.
