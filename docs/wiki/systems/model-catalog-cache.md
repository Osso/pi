# OpenRouter model catalog cache

[Contract](../../specs/model-catalog-cache.md)

## Startup versus refresh

Normal startup calls `loadOpenRouterCatalogAtStartup()` in [`main.ts`](../../../packages/coding-agent/src/main.ts), before registry creation. [`model-catalog-cache.ts`](../../../packages/coding-agent/src/core/model-catalog-cache.ts) reads `$XDG_CACHE_HOME/pi/models/openrouter.json` (default `~/.cache/pi/models/openrouter.json`; see [config location](config-location.md)). Valid caches younger than seven days supplement bundled models; missing, unreadable, invalid or stale caches yield bundled models without a network request.

The merged array is process-memoized. [`model-registry.ts`](../../../packages/coding-agent/src/core/model-registry.ts) consumes it synchronously, retaining bundled OpenRouter entries on ID collisions. This cache adds models; it does not replace bundled compatibility/thinking metadata or change custom `models.json` behavior.

`pi --refresh-models`, parsed in [`args.ts`](../../../packages/coding-agent/src/cli/args.ts), forces refresh and exits after a count/path summary. The request needs no authentication. Failure propagates rather than reporting bundled-only startup as refresh success.

## Refresh data flow

The mapper accepts only catalog entries advertising `tools`; it maps reasoning, text/image inputs, context/output limits and per-million-token pricing. Cache JSON contains `fetchedAt` and normalized models. Writes use a same-directory temporary file plus rename; failures report the destination and attempt temporary-file cleanup without replacing the old cache.

One five-second deadline covers up to three attempts. HTTP 429/5xx and the recognized `fetch failed` network error may retry with exponential jitter and `Retry-After`, only if another attempt fits the deadline. Invalid payloads/nontransient responses do not retry.

## Limits

No background refresh, slash-command refresh or runtime catalog for other providers exists. The freshness check uses timestamp age directly; a future timestamp also passes its less-than-seven-days comparison. Registry construction before startup loading sees bundled models. These are implementation details, not broader cache guarantees.

## Test evidence

Inspected, not run: [`model-catalog-cache.test.ts`](../../../packages/coding-agent/test/model-catalog-cache.test.ts) contains mapping, freshness/force refresh, additive collision handling, memoized registry loading, retry/timeout/write errors, cache preservation, and offline CLI listing/refresh scenarios.
