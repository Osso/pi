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

- Fixed provider `"length"` truncation being forced through the text-only `end_turn` continuation; truncated responses now terminalize the loop so hosts can compact or recover them.
- Fixed text-only continuations with an active `end_turn` tool by appending a runtime-only instruction that tells the model its prior response was delivered and must be terminated without inferring a new user request; the instruction is not emitted or persisted.
- Fixed `Agent.steer()` to abort an active model request while leaving active tool execution uninterrupted; queued steering remains available for the continuation.
- Fixed aborted model stream acquisition and iteration remaining pending indefinitely when a provider ignores its abort signal; the agent run now terminalizes without waiting for provider cooperation.
- Fixed aborted tool execution remaining pending indefinitely when a tool ignores its abort signal, allowing hosts to interrupt the run and process queued input.
- Fixed `Agent.continue()` to allow continuing transcripts whose last message is an assistant message.
- Fixed harness compaction summaries to omit assistant thinking content and avoid reasoning-mode summary requests.
- Fixed harness split-turn compaction to serialize summary requests so single-concurrency providers are not asked to run overlapping generations ([#5536](https://github.com/earendil-works/pi/issues/5536)).
- Fixed harness compaction to split a boundary-start active turn once cumulative assistant/tool context exceeds the protected suffix, while retaining later active turns whole when older compactable history exists.

## [0.80.3] - 2026-06-30

### Added

- Added `prepareNextTurnWithContext` for `Agent` users that need the next-turn loop context.

### Fixed

- Fixed oversized harness shell execution timeouts to fail with a clear validation error instead of being clamped to an immediate timeout ([#6181](https://github.com/earendil-works/pi/issues/6181)).
- Fixed `Agent.prepareNextTurn` to keep receiving the run abort signal instead of the next-turn context.
