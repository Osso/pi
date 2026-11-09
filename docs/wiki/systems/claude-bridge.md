# Claude bridge

Contract: [Claude bridge](../../specs/claude-bridge.md). User configuration: [Claude bridge guide](../../../packages/coding-agent/docs/claude-bridge.md).

The first-party extension integrates the Claude Agent SDK as the `claude-bridge` provider and optionally registers AskClaude for other providers. It passes Pi tools to Claude Code and handles Claude-native WebSearch inside the provider; Pi's OpenAI-only `web_search` is not forwarded. Claude's response contains search results and source links.

The bridge uses the existing global and project `claude-bridge.json` settings and Claude credentials. Configured account profiles use the existing profile and quota state locations; this integration does not introduce a credential migration. The provider uses the calling session's working directory, and Pi's `/usage` dispatches Claude usage requests to the bridge.

The bundled extension replaces the need for a separately installed copy. The resource loader excludes extension paths whose nearest package manifest names `pi-claude-bridge` when the bundled factory is supplied; user settings and other packages remain unchanged.

Npm installs obtain the pinned Claude Agent SDK and its platform executable through package dependencies. Binary releases copy the matching executable and legal notices under `claude/` beside Pi. An explicit `provider.pathToClaudeCodeExecutable` remains authoritative; otherwise the bridge uses the shipped executable in compiled Pi and the SDK's normal executable selection in npm installs.

The [contract](../../specs/claude-bridge.md) maps tested loading, SDK request, context, configuration and packaging boundaries. Tests use fake SDK responses and synthetic credentials, not live Claude inference or search acceptance.
