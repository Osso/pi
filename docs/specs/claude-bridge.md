# Claude bridge

The first-party Claude bridge provides Claude Code-backed models and optional delegation from `packages/coding-agent/extensions/claude-bridge`. See the [system overview](../wiki/systems/claude-bridge.md) and [configuration guide](../../packages/coding-agent/docs/claude-bridge.md).

## What it must do

### Loading

- [x] Load the bundled bridge without a separate installation when first-party extensions are enabled.
- [x] Skip duplicate external bridge loads without editing user settings.

### Provider and authentication

- [ ] Preserve Claude model selection, streaming, tool execution, session history and working-directory behavior from the standalone bridge.
- [ ] Preserve existing Claude authentication, configuration paths, profile selection, quota rotation and account usage reporting without introducing a credential migration.
- [x] Enable Claude Code native WebSearch for provider requests without forwarding Pi's OpenAI-only `web_search` tool or enabling other native tools.
- [x] Forward the calling Pi session's project context and preserve assistant replies through the bundled provider.
- [x] Merge project settings over global settings and preserve isolated named-profile credential paths and private permissions.
- [ ] Preserve Claude usage dispatch and configured account reporting.

### Delegation

- [x] Keep AskClaude disabled by default, preserve its configured tool name, and reject circular delegation from bridge sessions.
- [ ] Preserve AskClaude modes and session behavior for non-bridge providers.

### Distribution

- [x] Resolve compiled Pi's shipped Claude executable while preserving an explicit executable override and the SDK's npm executable selection.
- [x] Copy platform executables and their legal notices into binary release assets.
- [x] Preserve distinct workspace dependency versions and shared dependencies in generated installer locks and npm shrinkwrap.

## How it works

- [Claude bridge system overview](../wiki/systems/claude-bridge.md).
- [Configuration guide](../../packages/coding-agent/docs/claude-bridge.md).

## Implementation inventory

- `packages/coding-agent/extensions/claude-bridge/` — first-party bridge provider and tool.
- `packages/coding-agent/src/main.ts` — first-party extension loading.
- `packages/coding-agent/src/core/resource-loader.ts` — excludes external bridge copies when the bundled factory is supplied.
- `packages/coding-agent/package.json` — pinned bridge runtime dependencies.
- `scripts/claude-runtime.mjs` and `scripts/build-binaries.sh` — platform runtime assets.
- `scripts/generate-coding-agent-shrinkwrap.mjs` and `scripts/generate-coding-agent-install-lock.mjs` — distributable dependency locks.

## Tests asserting this spec

- `packages/coding-agent/test/claude-bridge-provider.test.ts` — model registration and SDK/MCP native-search request boundaries.
- `packages/coding-agent/test/claude-bridge-session.test.ts` — actual Pi session prompting with a fake SDK and project context.
- `packages/coding-agent/test/claude-bridge-config-profile-session.test.ts` — settings, synthetic credentials, and session identity.
- `packages/coding-agent/test/claude-bridge-convert.test.ts` — message and tool-result images.
- `packages/coding-agent/test/claude-bridge-askclaude.test.ts` — opt-in registration and circular-delegation rejection.
- `packages/coding-agent/test/claude-bridge-runtime.test.ts` — executable selection and explicit missing-asset errors.
- `packages/coding-agent/test/resource-loader.test.ts` — external-package/direct-path duplicate exclusion and unrelated extension loading.
- `packages/coding-agent/test/first-party-extension-availability.test.ts` — real-process startup inventory without a separate bridge or Claude command on PATH.
- `scripts/claude-runtime.test.mjs` — executable and notice copies for the six release platforms.
- `scripts/test-coding-agent-lock-generators.mjs` — workspace version conflicts and shared dependency resolution.

## Known gaps (current cycle)

The integration tests cover packaging, loading, native-search configuration and the fork API boundaries. The remaining unchecked preservation requirements were compared with the standalone implementation; they do not claim new comprehensive account-rotation, compaction or AskClaude integration coverage.

## Out of scope

- A new credential migration or change to authentication and billing policy.
- Changes to OpenAI hosted search or the Pyrun `pi.web_search` wrapper.
- Live authenticated Claude inference or web-search service acceptance; tests use fake SDK responses and synthetic credentials.
