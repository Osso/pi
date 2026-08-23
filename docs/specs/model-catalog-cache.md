# OpenRouter Model Catalog Cache

The coding agent supplements its bundled OpenRouter catalog with recently listed tool-capable models stored in the XDG user cache. Bundled metadata remains authoritative.

## What it must do

### Cache lifecycle

- [x] The cache file is `$XDG_CACHE_HOME/pi/models/openrouter.json`, defaulting to `~/.cache/pi/models/openrouter.json`.
- [x] The cache stores an ISO `fetchedAt` timestamp and normalized `Model<Api>[]` entries.
- [x] A missing cache triggers an OpenRouter catalog request.
- [x] A cache younger than seven days is used without a network request.
- [x] A cache at least seven days old triggers a refresh attempt.
- [x] A stale catalog request is aborted after approximately five seconds.
- [x] Cache write failures do not fail startup or discard a successfully fetched in-memory catalog.

### Catalog contents

- [x] Only OpenRouter entries that advertise tool support are added.
- [x] Runtime entries use the same base model metadata mapping as the generated OpenRouter catalog.
- [x] Refreshed models only add IDs missing from the bundled catalog.
- [x] Bundled entries win ID collisions so generated compatibility and thinking metadata remain authoritative.
- [x] Failed requests, timeouts, and invalid payloads fall back silently to the prior cache when available, otherwise to bundled models.
- [x] Corrupt but parseable cache data and HTTP error responses receive the same silent fallback behavior.
- [x] `ModelRegistry` loading remains synchronous and consumes the memoized merged OpenRouter catalog after startup refresh.

### CLI behavior

- [x] Print, interactive, model-listing, RPC, Architect, and Supervisor CLI startup refresh the catalog before creating a model registry. The shared CLI path is asserted end-to-end via `--list-models`; Architect and Supervisor use the same `refreshOpenRouterCatalog` helper at their entries (code-reviewed).
- [x] `--refresh-models` bypasses the seven-day freshness check without requiring authentication.
- [x] `--refresh-models` prints fetched, cached, bundled, and cache-path summary information before exiting successfully.
- [x] Offline startup reads and merges an available cache without performing a network request.

## How it works

- [Config location](config-location.md) defines the cache root.

## Implementation inventory

- `packages/coding-agent/src/config.ts` — resolves the XDG cache root.
- `packages/coding-agent/src/core/model-catalog-cache.ts` — reads, refreshes, writes, merges, and memoizes the OpenRouter catalog.
- `packages/coding-agent/src/core/model-registry.ts` — synchronously loads the memoized OpenRouter catalog.
- `packages/coding-agent/src/cli/args.ts` — parses and documents `--refresh-models`.
- `packages/coding-agent/src/main.ts` — awaits bounded refresh before CLI model-registry creation and handles forced refresh output.

## Tests asserting this spec

- `packages/coding-agent/test/model-catalog-cache.test.ts`

## Known gaps (current cycle)

None. The previously listed process-level and fallback assertions are covered in `packages/coding-agent/test/model-catalog-cache.test.ts`.

## Out of scope

- Runtime refresh for providers other than OpenRouter.
- Background refresh after startup.
- A TUI slash command for model catalog refresh.
- Changes to custom `models.json` behavior.
- Replacing bundled model metadata with runtime metadata.
