# Claude bridge

The first-party Claude bridge provides Claude Code-backed models and optional delegation from `packages/coding-agent/extensions/claude-bridge`. See the [system overview](../wiki/systems/claude-bridge.md) and [configuration guide](../../packages/coding-agent/docs/claude-bridge.md).

## What it must do

### Loading

- [ ] Load the bundled bridge without a separate installation when first-party extensions are enabled.
- [ ] Skip duplicate external bridge loads without editing user settings.

### Provider and authentication

- [ ] Preserve Claude model selection, streaming, tool execution, session history and working-directory behavior from the standalone bridge.
- [ ] Preserve existing Claude authentication, configuration paths, profile selection, quota rotation and account usage reporting without introducing a credential migration.
- [ ] Provide Claude Code native WebSearch for provider requests without forwarding Pi's OpenAI-only `web_search` tool or enabling other native tools.
- [ ] Preserve Claude usage dispatch and configured account reporting.

### Delegation

- [ ] Preserve the opt-in AskClaude tool, its configuration, modes and session behavior for non-bridge providers.

## How it works

- [Claude bridge system overview](../wiki/systems/claude-bridge.md).
- [Configuration guide](../../packages/coding-agent/docs/claude-bridge.md).

## Implementation inventory

- `packages/coding-agent/extensions/claude-bridge/` — first-party bridge provider and tool.
- `packages/coding-agent/src/main.ts` — first-party extension loading.

## Tests asserting this spec

Integration and regression test mapping is pending the implementation and test work. No requirements above are marked verified by this documentation change.

## Known gaps (current cycle)

- [ ] Verify the bundled integration and duplicate-load behavior against the preserved standalone contract.

## Out of scope

- A new credential migration or change to authentication and billing policy.
- Changes to OpenAI hosted search or the Pyrun `pi.web_search` wrapper.
