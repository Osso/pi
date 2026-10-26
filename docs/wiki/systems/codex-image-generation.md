# Codex hosted image generation

Contract: [Codex image generation](../../specs/codex-image-generation.md).

The default first-party `codex-image-generation` extension registers `image_gen` for every session model. Generation always runs on an `openai-codex`, `openai-codex-gc`, or `openai-codex-team` model: the session's model when it is one, otherwise the user's configured Codex model that has a login in `modelRegistry.getAvailable()`: `defaultProvider/defaultModel` first, then the first exact `provider/id` entry in `enabledModels` (glob patterns are not expanded). Registry defaults such as `defaultModelPerProvider` are not used because ChatGPT-account Codex rejects older model IDs (`gpt-5.5`). A Claude or Gemini session therefore generates through the user's Codex subscription. Authentication resolves through the Pi model registry, so Codex OAuth remains provider-owned and refreshes as usual. Without such a model the tool fails with a hint naming both settings and `pi login openai-codex`.

The extension leaves the callable function-shaped `image_gen` tool available for main-session dispatch. During its private one-shot generation request, it removes that function tool and adds the hosted `{ type: "image_generation" }` tool. On success, it writes a unique `image-gen-<id>.png` file in the active working directory and returns both a visible path and the generated image content.

The shared OpenAI Responses stream parser handles completed `image_generation_call` output items. When the item contains a result, it stores `{ type: "image", data, mimeType: "image/png" }` in `AssistantMessage.imageGenerationResult`; failed or empty results are ignored.

Implementation:

- `packages/coding-agent/src/main.ts` — loads the extension by default.
- `packages/coding-agent/extensions/codex-image-generation/src/index.ts`
- `packages/ai/src/api/openai-responses-shared.ts`
- `packages/ai/src/types.ts`
