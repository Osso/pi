# Claude bridge

Contract: [Claude bridge](../../specs/claude-bridge.md). User configuration: [Claude bridge guide](../../../packages/coding-agent/docs/claude-bridge.md).

The first-party extension integrates the Claude Agent SDK as the `claude-bridge` provider and optionally registers AskClaude for other providers. It passes Pi tools to Claude Code and handles Claude-native WebSearch inside the provider; Pi's OpenAI-only `web_search` is not forwarded. Claude's response contains search results and source links.

The bridge uses the existing global and project `claude-bridge.json` settings and Claude credentials. Configured account profiles use the existing profile and quota state locations; this integration does not introduce a credential migration. The provider uses the calling session's working directory, and Pi's `/usage` dispatches Claude usage requests to the bridge.

The bundled extension replaces the need for a separately installed copy. Duplicate external bridge loads are skipped without rewriting user settings. The contract and test mapping remain unverified until the integration tests run.
