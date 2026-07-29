# Codex hosted image generation

The default first-party `codex-image-generation` extension registers `image_gen` for `openai-codex` and `openai-codex-gc` provider models. It resolves authentication through the active Pi model registry, so Codex OAuth remains provider-owned.

The extension leaves the callable function-shaped `image_gen` tool available for main-session dispatch. During its private one-shot generation request, it removes that function tool and adds the hosted `{ type: "image_generation" }` tool. On success, it writes a unique `image-gen-<id>.png` file in the active working directory and returns both a visible path and the generated image content.

The shared OpenAI Responses stream parser handles completed `image_generation_call` output items. When the item contains a result, it stores `{ type: "image", data, mimeType: "image/png" }` in `AssistantMessage.imageGenerationResult`; failed or empty results are ignored.

Implementation:

- `packages/coding-agent/src/main.ts` — loads the extension by default.
- `packages/coding-agent/extensions/codex-image-generation/src/index.ts`
- `packages/ai/src/api/openai-responses-shared.ts`
- `packages/ai/src/types.ts`
