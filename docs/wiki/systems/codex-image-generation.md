# Codex hosted image generation

The `codex-image-generation` extension registers `image_gen` for OpenAI Responses and OpenAI Codex Responses models. It resolves authentication through the active Pi model registry, so Codex OAuth remains provider-owned.

For supported provider requests, the extension's `before_provider_request` hook removes the function-shaped `image_gen` tool and adds the hosted `{ type: "image_generation" }` tool. The extension also uses the same payload rewrite for its one-shot generation request, then returns the generated image as tool content.

The shared OpenAI Responses stream parser handles completed `image_generation_call` output items. When the item contains a result, it stores `{ type: "image", data, mimeType: "image/png" }` in `AssistantMessage.imageGenerationResult`; failed or empty results are ignored.

Implementation:

- `packages/coding-agent/extensions/codex-image-generation/src/index.ts`
- `packages/ai/src/api/openai-responses-shared.ts`
- `packages/ai/src/types.ts`
