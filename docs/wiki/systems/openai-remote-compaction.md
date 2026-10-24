# OpenAI Saved Compaction History

Contract: [OpenAI saved compaction history](../../specs/openai-remote-compaction.md).

## Removed endpoint integration

The optional `packages/coding-agent/extensions/openai-remote-compact` extension has been removed, together with its endpoint-only tests. Pi no longer supplies that caller for OpenAI `/responses/compact` or the ChatGPT backend `/codex/responses/compact`. Its endpoint payload selection, 400,000-character budget, deduplication, split-turn pinning, and endpoint-specific guidance are no longer active features.

Normal compaction still generates plaintext summaries. Generic compaction hooks remain available for custom implementations; removing this extension does not remove the hook API. See the [compaction manual](../../../packages/coding-agent/docs/compaction.md).

## Retained saved-history handling

Existing sessions can contain OpenAI-native replacement history, including encrypted compaction items. Their compaction entries carry a provider-native checkpoint and may retain OpenAI remote-compaction `details`; the visible summary can be a synthetic placeholder. Removing the endpoint caller does not delete or rewrite these entries.

When later context is serialized for a matching OpenAI Responses provider/API, Pi carries the saved native history on the synthetic compaction-summary message. The shared OpenAI Responses serializer inserts matching native items instead of the synthetic summary text. Native history remains reusable across generation-model switches within the same matching provider/API. A newer plaintext compaction supersedes the older native context.

## Editing existing native entries

In `/tree`, a plaintext compaction summary opens directly in the editor. An existing OpenAI-native entry is materialized first through one normal generation request using the active model only when its provider/API exactly matches the saved `openai.responses.input` checkpoint. This is not a compact-endpoint request, and there is no provider/model fallback.

Materialization is not persisted. Escape or failure leaves the entry unchanged. Saving the edited native entry atomically replaces the placeholder with plaintext and removes the provider-native checkpoint and OpenAI remote-compaction details while preserving entry identity, tree position, leaf, and token/duration metadata.
