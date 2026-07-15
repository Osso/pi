# Changelog

## [Unreleased]

### Breaking Changes

- Added `model_request_start` and `model_request_end` to `AgentEvent`; exhaustive event consumers must handle the provider-request lifecycle variants.
- Added required `startedAt` timing metadata to `tool_execution_start` and required `startedAt`/`finishedAt` metadata to `tool_execution_end` `AgentEvent` payloads. Custom `AgentEvent` producers must include Unix-epoch millisecond timestamps; consumers can calculate elapsed tool time as `finishedAt - startedAt`.

### Added

- Added authoritative `AgentState.isModelRequestActive` state for distinguishing model requests from tool execution.
- Added an `onRetry` agent option forwarded to the stream function, mirroring `onPayload`/`onResponse`, so hosts can observe provider-internal retries.
- Added optional tool execution context carrying the same `startedAt` timestamp emitted by tool lifecycle events.

### Fixed

- Fixed `Agent.steer()` to abort an active model request while leaving active tool execution uninterrupted; queued steering remains available for the continuation.
- Fixed aborted model stream acquisition and iteration remaining pending indefinitely when a provider ignores its abort signal; the agent run now terminalizes without waiting for provider cooperation.
- Fixed `Agent.continue()` to allow continuing transcripts whose last message is an assistant message.
- Fixed harness compaction summaries to omit assistant thinking content and avoid reasoning-mode summary requests.
- Fixed harness split-turn compaction to serialize summary requests so single-concurrency providers are not asked to run overlapping generations ([#5536](https://github.com/earendil-works/pi/issues/5536)).

## [0.80.3] - 2026-06-30

### Added

- Added `prepareNextTurnWithContext` for `Agent` users that need the next-turn loop context.

### Fixed

- Fixed oversized harness shell execution timeouts to fail with a clear validation error instead of being clamped to an immediate timeout ([#6181](https://github.com/earendil-works/pi/issues/6181)).
- Fixed `Agent.prepareNextTurn` to keep receiving the run abort signal instead of the next-turn context.
