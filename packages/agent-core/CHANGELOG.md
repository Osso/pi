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

### Changed

- `Agent.steer()` during a thinking or text block now waits for the block to end instead of aborting mid-block; the request ends there, the completed blocks are kept with a short interruption note (stopReason `stop`), and the run continues with the steering message. During a message with a tool call the steer still aborts at once, so the steered tool does not run. New `AgentLoopConfig.shouldInterruptAfterBlock` hook and exported `STEERING_INTERRUPTION_NOTE`.

### Fixed

- `JsonlSessionStorage` adds the missing newline before appending to a reopened session file whose last record has none.
- Nested skill ignore files now work in directories whose names contain glob characters such as `team[1]`; the directory prefix is escaped before it is joined to each rule
- Fixed a sequential tool call still running when the agent was aborted while a `tool_execution_start` listener ran; it now reports `Operation aborted`, as parallel calls already did
- Fixed `executeShellWithCapture` losing the output tail when a large chunk was followed by a short one: the rolling buffer dropped the large chunk and kept only the short one (port of the coding-agent fix)
- Fixed `truncateHead` and `truncateTail` reporting truncation for output that ends in a newline and fits the limits: the final newline was counted as an extra line (`truncateHead`) and against the byte limit (port of the coding-agent fix)
- Fixed harness skills and prompt templates ignoring their frontmatter when the file starts with a UTF-8 BOM (port of the coding-agent fix)
- Fixed `AgentHarness.compact()` sending whole tool call arguments (for example a large `write` content) to the summarization model; each argument is now cut to 1000 characters, as in coding-agent
- Fixed harness compaction counting hidden `!!` bash executions (`excludeFromContext`) in token estimates and toward `keepRecentMessages`; trailing hidden commands used up the kept window and the real recent messages were summarized
- Fixed harness compaction dropping the read and modified file lists of summarized branch summary entries
- Fixed harness compaction reporting `tokensBefore` from usage of messages kept by the previous compaction, which describes the old, larger context; it now estimates from message content when no newer usage exists
- Fixed harness compaction treating a clean cut as a split turn when model, thinking-level or label entries precede the kept user message, or when the cut lands on a custom message; the previous turn was summarized as the split-turn prefix
- Fixed `AgentHarness.compact()` custom instructions being ignored for the turn-prefix summary of a split turn ([#11058](https://github.com/earendil-works/pi-mono/issues/11058))
- Compaction serialization and `truncateLine` no longer cut an emoji in half at the truncation limit ([#7121](https://github.com/earendil-works/pi-mono/issues/7121))
- `parseCommandArgs` keeps apostrophes inside words, keeps an unclosed quote as text, and unescapes the enclosing quote character inside a quoted argument (upstream [#11861](https://github.com/earendil-works/pi/issues/11861))
- Fixed aborting during a tool batch leaving the calls the loop had not reached without a tool result; each now gets start/end events and an `Operation aborted` result, and `beforeToolCall` is not asked about them (ported from upstream #9986).
- Fixed `streamProxy` leaving `result()` pending when the proxy closed the stream without a `done` or `error` event; it now ends with an error ([#8996](https://github.com/earendil-works/pi-mono/issues/8996)).
- Fixed harness branch summaries dropping the read and modified file lists from earlier compaction entries.
- Fixed `afterToolCall` returning `details: null` keeping the tool's original details instead of replacing them.
- Fixed parallel tool execution starting tools whose preflight finished before a later preflight aborted the run ([#8935](https://github.com/earendil-works/pi-mono/issues/8935)).
- Fixed prompt templates and skills that start with a `----` Markdown thematic break losing their first lines: frontmatter now requires whole `---` delimiter lines.
- Fixed `Agent.continue({ processQueuedMessagesFirst: true })` throwing `No messages to continue from` on an empty transcript with queued steering or follow-ups; the queued messages now start the run (for example RPC `steer` in a new session).
- Fixed `Agent` emitting an unpaired `turn_end` when a run fails between turns, such as an abort during tool execution; the failure message now gets its own `turn_start`.
- Fixed `agentLoopContinue` omitting `turn_start` for the model response that follows a restored unfinished tool batch.
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
