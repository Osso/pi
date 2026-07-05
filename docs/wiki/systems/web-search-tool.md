# Web search tool

The first-party `codex-web-search` extension registers the model-callable `web_search` tool. The tool runs a one-shot OpenAI Responses request with the hosted OpenAI web search tool in that request payload, then returns normal text content to Pi.

Pyrun does not have a web-search-specific Pi bridge method. Its Python-side `pi.web_search(query)` helper is a convenience wrapper over the generic `pi.tools.call("web_search", {"query": query})` bridge. Pi gates that bridge through the active tool registry before executing the registered tool definition.
