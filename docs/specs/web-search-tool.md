# Web search tool

Module boundary: first-party extension module.

The web search tool exposes OpenAI Responses hosted web search as an explicit callable Pi tool. It is registered by the first-party `codex-web-search` extension and appears in tool inventory when extensions are loaded.

## What it must do

### Tool surface

- [x] Register a callable `web_search` tool instead of a CLI flag.
- [x] Keep legacy web-search CLI modes out of the extension API surface.
- [x] Accept a required `query` string parameter.

### Execution

- [x] Use the current OpenAI Responses or OpenAI Codex Responses model for hosted web search.
- [x] Reject execution when the current model is not hosted-web-search capable.
- [x] Return the hosted search text as the tool result.

## How it works

- [ ] See [`docs/wiki/systems/web-search-tool.md`](../wiki/systems/web-search-tool.md).

## Implementation inventory

- `packages/coding-agent/extensions/codex-web-search/src/index.ts` - Registers and executes the `web_search` tool.
- `packages/coding-agent/src/main.ts` - Loads the first-party web search extension.
- `packages/coding-agent/CHANGELOG.md` - Records the user-visible feature change.

## Tests asserting this spec

- `packages/coding-agent/test/codex-web-search-extension.test.ts`

## Known gaps (current cycle)

- [ ] Add an integration-style tool inventory assertion that `web_search` appears in `pi tools` when first-party extensions are loaded.

## Out of scope

- Codex-compatible `web.run` browsing/search API compatibility.
- Non-OpenAI web search providers.
- A cached/offline web search mode.
