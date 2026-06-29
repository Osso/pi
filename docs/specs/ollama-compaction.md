# Ollama Compaction

Default Ollama compaction summarizes Pi session history with a configured Ollama model, independent of the active chat model. How it works is tracked in [Ollama compaction](../wiki/systems/ollama-compaction.md).

## What it must do

- [x] Default manual compaction must use a configured Ollama model even when the active chat model is from another provider.
- [x] Default manual compaction must fail explicitly when no configured Ollama model is available.
- [x] The OpenAI remote compaction first-party extension must not be registered.
- [x] Compaction UI labels must report the Ollama model used for summary generation.

## How it works

- [Ollama compaction](../wiki/systems/ollama-compaction.md)

## Implementation inventory

- `packages/coding-agent/src/core/agent-session.ts` — resolves the Ollama compaction model and runs default manual/auto compaction with it.
- `packages/coding-agent/src/core/compaction/compaction.ts` — generates summaries and records local source metadata.
- `packages/coding-agent/src/core/settings-manager.ts` — reads compaction model configuration.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — displays Ollama compaction progress and completion labels.
- `packages/coding-agent/src/main.ts` — first-party extension inventory excludes OpenAI remote compaction.

## Tests asserting this spec

- `packages/coding-agent/test/ollama-compaction.test.ts`
- `packages/coding-agent/test/interactive-mode-compaction.test.ts`

## Known gaps (current cycle)

- [ ] Auto-compaction Ollama model selection is covered indirectly by the shared `AgentSession` compaction path, but dedicated auto-compaction model-selection regression coverage should be added if the behavior changes again.

## Out of scope

- OpenAI `/responses/compact` and native encrypted replacement-history preservation are removed.
- Branch summarization still uses its existing summarization path and is not part of this compaction replacement.
