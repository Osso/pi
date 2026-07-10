# OpenAI Remote Compaction

OpenAI remote compaction is implemented as a first-party Pi extension. During `session_before_compact`, the extension handles first-party `openai` provider models using the `openai-responses` API and first-party `openai-codex` / `openai-codex-gc` provider models using the `openai-codex-responses` API.

The extension sends the compacted span to the model's compact endpoint. OpenAI API models use `/responses/compact`; Codex subscription models use the ChatGPT backend `/codex/responses/compact` endpoint with Codex account headers. The endpoint returns native OpenAI replacement history, including a `compaction` item with encrypted content. Pi stores that native replacement history in `CompactionEntry.details` and stores a short synthetic summary string in `CompactionEntry.summary`.

Compact input is capped at 400,000 serialized characters. When prior native replacement history fits within the limit, the extension pins its complete item groups before allocating the remaining budget to newer raw context. If that native history already exceeds the limit, encrypted `compaction` or `compaction_summary` items remain pinned when they fit while non-encrypted native context is reduced alongside raw context. An encrypted item larger than the complete input budget is omitted rather than overflowing the request or cancelling compaction. Native and raw items form separate tool-grouping regions, preventing an orphan native call from splitting a raw call/output pair.

When later context is serialized for an OpenAI Responses model, Pi carries the saved native history on the synthetic compaction-summary message. The shared OpenAI Responses serializer inserts matching native items instead of serializing the synthetic summary text.

This keeps Pi's existing session-tree compaction model while preserving OpenAI-native compacted context for OpenAI requests.
