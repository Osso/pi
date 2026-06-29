# OpenAI Remote Compaction

OpenAI remote compaction is implemented as a first-party Pi extension. During `session_before_compact`, the extension handles first-party `openai` provider models using the `openai-responses` API and first-party `openai-codex` / `openai-codex-gc` provider models using the `openai-codex-responses` API.

The extension sends the compacted span to the model's compact endpoint. OpenAI API models use `/responses/compact`; Codex subscription models use the ChatGPT backend `/codex/responses/compact` endpoint with Codex account headers. The endpoint returns native OpenAI replacement history, including a `compaction` item with encrypted content. Pi stores that native replacement history in `CompactionEntry.details` and stores a short synthetic summary string in `CompactionEntry.summary`.

On later `before_provider_request` events, the extension scans OpenAI Responses payloads for Pi's synthetic compaction-summary message. When it finds one, it replaces that synthetic text message with the saved native replacement history before the provider request is sent.

This keeps Pi's existing session-tree compaction model while preserving OpenAI-native compacted context for OpenAI requests.
