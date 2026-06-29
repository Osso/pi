# Ollama Compaction

Pi default compaction uses an Ollama model for summary generation regardless of the active chat model. The active model still determines normal chat turns and context-overflow detection, but the default summary generation request is sent to the configured Ollama compaction model.

Model selection comes from `compaction.model` in settings when set. If it is unset, Pi uses the first available configured `ollama` model in the model registry. The Ollama provider must be present in `models.json` with request auth configured; for local Ollama, an `apiKey` placeholder is enough because Ollama ignores it.

Manual and automatic default compaction both resolve the Ollama model before generating a summary. If no matching Ollama model is available, default compaction fails explicitly instead of falling back to the active chat model.

OpenAI remote compaction and `/responses/compact` replacement-history handling are not part of this path.
