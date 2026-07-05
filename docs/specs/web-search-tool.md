# Web search tool

Module boundary: first-party extension module.

The web search tool exposes OpenAI Responses hosted web search as an explicit callable Pi tool. It is registered by the first-party `codex-web-search` extension and appears in tool inventory when extensions are loaded.

## What it must do

### Tool surface

- [x] Register a callable `web_search` tool instead of a CLI flag.
- [x] Keep legacy web-search CLI modes out of the extension API surface.
- [x] Accept a required `query` string parameter.
- [x] Appear as active in formatted tool inventory when the first-party extension is loaded.

### Execution

- [x] Use the current OpenAI Responses or OpenAI Codex Responses model for hosted web search.
- [x] Reject execution when the current model is not hosted-web-search capable.
- [x] Return the hosted search text as the tool result.

### Pyrun bridge

- [x] Expose web search to Pyrun as `pi.web_search(query)`.
- [x] Implement `pi.web_search(query)` as a convenience wrapper over the generic `pi.tools.call("web_search", { query })` bridge.
- [x] Route Pyrun tool bridge requests through the active Pi tool registry instead of a web-search-specific bridge method.

## How it works

- [ ] See [`docs/wiki/systems/web-search-tool.md`](../wiki/systems/web-search-tool.md).

## Implementation inventory

- `packages/coding-agent/extensions/codex-web-search/src/index.ts` - Registers and executes the `web_search` tool.
- `packages/coding-agent/extensions/pyrun/src/index.ts` - Exposes generic `tools.call` bridge handling and documents the `pi.web_search(query)` helper in model-facing Pyrun guidance.
- `packages/coding-agent/src/main.ts` - Loads the first-party web search and Pyrun extensions.
- `/syncthing/Sync/Projects/claude/pyrun/pyrun/runtime.py` - Defines the canonical Python-side `pi.web_search(...)` helper.
- `packages/coding-agent/CHANGELOG.md` - Records the user-visible feature change.

## Tests asserting this spec

- `packages/coding-agent/test/codex-web-search-extension.test.ts`
- `packages/coding-agent/test/pyrun-extension.test.ts`
- `packages/coding-agent/test/tool-inventory-session.test.ts`
- `/syncthing/Sync/Projects/claude/pyrun/tests/test_runtime.py`
- `/syncthing/Sync/Projects/claude/pyrun/tests/test_jsonl.py`

## Known gaps (current cycle)

None.

## Out of scope

- Codex-compatible `web.run` browsing/search API compatibility.
- Non-OpenAI web search providers.
- A cached/offline web search mode.
