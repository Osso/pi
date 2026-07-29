# Codex hosted image generation

Module boundary: first-party extension module with shared OpenAI Responses API support.

The `codex-image-generation` extension exposes hosted image generation as a callable `image_gen` tool for OpenAI Responses and OpenAI Codex Responses models. Shared AI response handling surfaces completed hosted image results on `AssistantMessage`. Runtime details belong in [`docs/wiki/systems/codex-image-generation.md`](../wiki/systems/codex-image-generation.md).

## What it must do

### Tool surface

- [x] Register a callable `image_gen` tool with a required `prompt` string.
- [x] Load the extension as a default first-party tool.
- [x] Accept the tool only for `openai-codex` and `openai-codex-gc` provider models.

### Hosted request

- [x] Add one hosted `{ type: "image_generation" }` tool to supported OpenAI Responses payloads.
- [x] Remove the same-named function tool before sending the hosted request and avoid adding a duplicate hosted tool.
- [x] Use the current model's resolved authentication and return the generated image as tool content.

### Response result

- [x] Convert a completed `image_generation_call` with image data into `AssistantMessage.imageGenerationResult` as PNG image content.
- [x] Ignore failed or data-less image-generation calls without emitting image content.

## How it works

- [`docs/wiki/systems/codex-image-generation.md`](../wiki/systems/codex-image-generation.md)

## Implementation inventory

- `packages/coding-agent/src/main.ts` — loads the extension as a default first-party extension.
- `packages/coding-agent/extensions/codex-image-generation/src/index.ts` — registers `image_gen`, injects the hosted tool, resolves current provider authentication, and returns generated image content.
- `packages/ai/src/api/openai-responses-shared.ts` — parses completed hosted image-generation response items.
- `packages/ai/src/types.ts` — defines `AssistantMessage.imageGenerationResult`.

## Tests asserting this spec

- `packages/coding-agent/test/codex-image-generation-extension.test.ts`
- `packages/ai/test/openai-responses-image-generation.test.ts`

## Known gaps (current cycle)

- [ ] Add a real-provider integration test covering a live hosted image-generation call.

## Out of scope

- OpenRouter image-generation API calls.
- Image editing, inpainting, masks, batch generation, or transparent-output processing.
- Persisting generated files outside normal image-content handling.
