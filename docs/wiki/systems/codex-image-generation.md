# Codex hosted image generation

The default first-party `codex-image-generation` extension registers `image_gen` for `openai-codex` and `openai-codex-gc` provider models. It resolves authentication through the active Pi model registry, so Codex OAuth remains provider-owned.

For supported provider requests, the extension's `before_provider_request` hook removes the function-shaped `image_gen` tool and adds the hosted `{ type: "image_generation" }` tool. The extension also uses the same payload rewrite for its one-shot generation request. On success, it writes a unique `image-gen-<id>.png` file in the active working directory and returns both a visible path and the generated image content.

The shared OpenAI Responses stream parser handles completed `image_generation_call` output items. When the item contains a result, it stores `{ type: "image", data, mimeType: "image/png" }` in `AssistantMessage.imageGenerationResult`; failed or empty results are ignored.

Implementation:

- `packages/coding-agent/src/main.ts` — loads the extension by default.
- `packages/coding-agent/extensions/codex-image-generation/src/index.ts`
- `packages/ai/src/api/openai-responses-shared.ts`
- `packages/ai/src/types.ts`
