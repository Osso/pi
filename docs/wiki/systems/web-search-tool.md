# Web search tool

Contract: [Web search tool](../../specs/web-search-tool.md).

The first-party `codex-web-search` extension registers `web_search` with a required `query` string and approval-required execution. Direct execution trims the query, rejects an empty value, and requires the active model API to be `openai-responses` or `openai-codex-responses`. Authentication comes from that model's registry entry; there is no separate search account.

## Request paths

The extension's `before_provider_request` hook also enables hosted search in ordinary compatible model requests. It removes the function-shaped `web_search` entry and adds `{ type: "web_search", external_web_access: true }`, without duplicating an existing hosted search entry. Consequently, registry availability does not mean compatible providers receive the callable function schema: they receive OpenAI's hosted tool instead.

When Pi executes the registered tool directly, it makes a separate one-shot request using the active model and the same hosted-tool payload conversion. It joins returned assistant text blocks into the result. Provider errors, cancellation, and empty text fail explicitly. A three-minute timeout is combined with caller cancellation and cleared when the request settles.

## Pyrun bridge

Pyrun does not have a web-search-specific Pi bridge method. Its Python-side `pi.web_search(query)` helper is a convenience wrapper over the generic `pi.tools.call("web_search", {"query": query})` bridge. Pi gates that bridge through the active tool registry before executing the registered tool definition.

## Source and coverage

- [Extension implementation](../../../packages/coding-agent/extensions/codex-web-search/src/index.ts) owns registration, provider payload conversion, authentication, timeout, and result extraction.
- [Pyrun adapter](../../../packages/coding-agent/extensions/pyrun/src/index.ts) handles generic tool bridge calls.
- [Extension tests](../../../packages/coding-agent/test/codex-web-search-extension.test.ts), [Pyrun tests](../../../packages/coding-agent/test/pyrun-extension.test.ts), and [inventory tests](../../../packages/coding-agent/test/tool-inventory-session.test.ts) cover these boundaries. Test locations are not a fresh run claim.

This tool does not implement a general browsing API, non-OpenAI search, or offline caching.
