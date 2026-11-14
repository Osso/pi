# Changelog

## [Unreleased]

### Breaking Changes

- Replaced `CompactionSettings.keepRecentTokens` with `keepRecentMessages` (default 20); harness compaction keeps that many newest context messages instead of the last 3 messages or 10,000 tokens.
- Added `model_request_start` and `model_request_end` to `AgentEvent`; exhaustive event consumers must handle the provider-request lifecycle variants.
- Added required `startedAt` timing metadata to `tool_execution_start` and required `startedAt`/`finishedAt` metadata to `tool_execution_end` `AgentEvent` payloads. Custom `AgentEvent` producers must include Unix-epoch millisecond timestamps; consumers can calculate elapsed tool time as `finishedAt - startedAt`.

- Changed `AgentTool` details and `AgentToolUpdateCallback` type defaults from `any` to `unknown`; tool execution event arguments and result details also require narrowing. Tool execution and preparation members now use method syntax, and public model types use `Model<Api>` instead of `Model<any>`.

### Added

- Added authoritative `AgentState.isModelRequestActive` state for distinguishing model requests from tool execution.
- Added an `onRetry` agent option forwarded to the stream function, mirroring `onPayload`/`onResponse`, so hosts can observe provider-internal retries.
- Extended optional tool execution context with durable `agentId` metadata alongside the `startedAt` timestamp emitted by tool lifecycle events.
- Added optional `AgentTool.prepareExecution` for preparing durable execution metadata before the assistant tool call is persisted.
- Added optional `processQueuedMessagesFirst` handling to `Agent.continue()` so callers can drain steering and follow-up messages queued by `agent_end` handlers before a blank continuation.

### Fixed

- Fixed `parseCommandArgs` dropping quoted empty arguments (`""`, `''`), which shifted later positional template arguments.
- Fixed steering aborts discarding an in-flight assistant reply; streamed content and metadata are retained with one message completion instead of a new empty assistant message, and tool calls from the interrupted response are not executed.
- Fixed queued steering after a text-only response being paired with the stale runtime-only `end_turn` completion instruction; steering now takes precedence for the following provider request.
- Fixed provider `"length"` truncation being forced through the text-only `end_turn` continuation; truncated responses now terminalize the loop so hosts can compact or recover them.
- Fixed text-only continuations with an active `end_turn` tool by appending a runtime-only instruction that tells the model its prior response was delivered and must be terminated without inferring a new user request; the instruction is not emitted or persisted.
- Fixed `Agent.steer()` to abort an active model request while leaving active tool execution uninterrupted; queued steering remains available for the continuation.
- Fixed aborted model stream acquisition and iteration remaining pending indefinitely when a provider ignores its abort signal; the agent run now terminalizes without waiting for provider cooperation.
- Fixed aborted tool execution remaining pending indefinitely when a tool ignores its abort signal, allowing hosts to interrupt the run and process queued input.
- Fixed `Agent.continue()` to allow continuing transcripts whose last message is an assistant message.
- Fixed harness compaction summaries to omit assistant thinking content and avoid reasoning-mode summary requests.
- Fixed harness split-turn compaction to serialize summary requests so single-concurrency providers are not asked to run overlapping generations ([#5536](https://github.com/earendil-works/pi/issues/5536)).
- Fixed harness compaction to split a boundary-start active turn once cumulative assistant/tool context exceeds the protected suffix, while retaining later active turns whole when older compactable history exists.
- Fixed `formatPromptTemplateInvocation` substituting placeholders found inside argument values: an argument such as `use $@ here` was expanded again instead of being inserted literally.
- Fixed repeated compaction discarding the previous compaction summary when it split a long turn that the previous compaction had kept: the summary became `No prior history.` plus the turn prefix, so all earlier history was lost. The previous summary is now carried forward.
- Fixed the tool-result cap cutting the start of tool output that was already truncated to 10KB / 2000 lines plus a continuation notice; the cap is now 11KB / 2010 lines, and `isToolResultTextTooLarge` is exported for hosts that apply their own cap.
- Fixed tool result `details` being replaced by a truncation marker once their JSON exceeded the 11KB model-text cap, although details are not part of the tool result content the model receives; details now have a separate 1 MiB storage cap.
- Fixed nested skill ignore rules matching only immediate children instead of all descendant paths, while preserving anchored patterns, negation, and escaped prefixes.
- Fixed branch summaries losing file-operation history from older messages excluded by the summary token budget.

## [0.80.3] - 2026-06-30

### Added

- Added `prepareNextTurnWithContext` for `Agent` users that need the next-turn loop context.

### Fixed

- Fixed oversized harness shell execution timeouts to fail with a clear validation error instead of being clamped to an immediate timeout ([#6181](https://github.com/earendil-works/pi/issues/6181)).
- Fixed `Agent.prepareNextTurn` to keep receiving the run abort signal instead of the next-turn context.
