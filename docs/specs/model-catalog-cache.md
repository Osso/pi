# OpenRouter Model Catalog Cache

The coding agent supplements its bundled OpenRouter catalog with recently listed tool-capable models stored in the XDG user cache. Bundled metadata remains authoritative.

## What it must do

### Cache lifecycle

- [x] The cache file is `$XDG_CACHE_HOME/pi/models/openrouter.json`, defaulting to `~/.cache/pi/models/openrouter.json`.
- [x] The cache stores an ISO `fetchedAt` timestamp and normalized `Model<Api>[]` entries.
- [ ] Normal startup uses and merges a cache younger than seven days without a network request.
- [ ] Normal startup uses bundled models when the cache is missing or at least seven days old.
- [ ] Only `pi --refresh-models` requests the OpenRouter catalog; no normal CLI startup path sends that request.
- [ ] The `--refresh-models` request is aborted after approximately five seconds.
- [ ] Cache write failures do not fail `--refresh-models` or discard a successfully fetched in-memory catalog.

### Catalog contents

- [x] Only OpenRouter entries that advertise tool support are added.
- [x] Runtime entries use the same base model metadata mapping as the generated OpenRouter catalog.
- [x] Refreshed models only add IDs missing from the bundled catalog.
- [x] Bundled entries win ID collisions so generated compatibility and thinking metadata remain authoritative.
- [ ] Failed `--refresh-models` requests, timeouts, and invalid payloads fall back silently to bundled models alone; the existing cache file is left untouched for a later successful refresh.
- [ ] Corrupt but parseable cache data and HTTP error responses receive the same silent fallback behavior.
- [ ] `ModelRegistry` loading remains synchronous and consumes the memoized cached-or-bundled OpenRouter catalog during normal startup.

### CLI behavior

- [ ] Print, interactive, model-listing, RPC, Architect, and Supervisor startup paths use only a fresh cache or bundled models before creating a model registry; they never wait for an OpenRouter catalog request.
- [ ] `--refresh-models` is the only catalog refresh operation, bypasses the seven-day freshness check, and requires no authentication.
- [ ] `--refresh-models` prints fetched, cached, bundled, and cache-path summary information before exiting successfully.
- [ ] Offline startup reads and merges an available fresh cache without performing a network request.

## How it works

- [Config location](config-location.md) defines the cache root.

## Implementation inventory

- `packages/coding-agent/src/config.ts` — resolves the XDG cache root.
- `packages/coding-agent/src/core/model-catalog-cache.ts` — reads, refreshes, writes, merges, and memoizes the OpenRouter catalog.
- `packages/coding-agent/src/core/model-registry.ts` — synchronously loads the memoized OpenRouter catalog.
- `packages/coding-agent/src/cli/args.ts` — parses and documents `--refresh-models`.
- `packages/coding-agent/src/main.ts` — loads cached-or-bundled models for normal startup and handles the explicit refresh output.

## Tests asserting this spec

- `packages/coding-agent/test/model-catalog-cache.test.ts`

## Known gaps (current cycle)

- [ ] Update `packages/coding-agent/test/model-catalog-cache.test.ts` for no-network normal startup and explicit-only refresh behavior.

## Out of scope

- Runtime refresh for providers other than OpenRouter.
- Background refresh after startup.
- A TUI slash command for model catalog refresh.
- Changes to custom `models.json` behavior.
- Replacing bundled model metadata with runtime metadata.
