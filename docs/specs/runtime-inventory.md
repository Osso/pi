# Runtime inventory commands

Runtime inventory commands expose what Pi actually loaded for the current startup context. The CLI actions and TUI slash commands are diagnostic surfaces for tools and extensions, so users can verify whether features such as multi-agent tools are available before relying on a model answer.

## What it must do

### Tool inventory

- [x] `pi tools` must parse as a metadata action, not as a prompt message.
- [x] `/tools` must be a built-in slash command.
- [x] Tool inventory output must include every configured tool, whether each tool is active, its source, and its description.
- [x] Tool inventory output must keep terminal table lines compact by truncating long descriptions.
- [x] Tool inventory output must show an explicit empty state when no tools are available.
- [x] Tool inventory data must include tools registered by extensions during `session_start`.
- [x] Tool inventory data must include default first-party runtime tools such as `spawn_agent`, `set_goal`, `goal_complete`, and `hostrun_eval`.

### Extension inventory

- [x] `pi extensions` must parse as a metadata action, not as a prompt message.
- [x] `/extensions` must be a built-in slash command.
- [x] Extension inventory output must include every loaded extension, its scope/source, and registered command/tool/handler counts.
- [x] Extension inventory output must show an explicit empty state when no extensions are loaded.
- [x] Extension inventory output must include built-in first-party runtime extensions such as `goal`, `hostrun`, `multi-agent`, and `run-plan` even while project trust is being resolved.

## How it works

- [ ] See [`docs/wiki/systems/runtime-inventory.md`](../wiki/systems/runtime-inventory.md).

## Implementation inventory

- `packages/coding-agent/src/cli/args.ts` - Parses `tools` and `extensions` metadata actions.
- `packages/coding-agent/src/cli/list-tools.ts` - Formats and prints current tool inventory.
- `packages/coding-agent/src/cli/list-extensions.ts` - Formats and prints current extension inventory.
- `packages/coding-agent/src/core/resource-loader.ts` - Preserves first-party synthetic extensions through project trust reload.
- `packages/coding-agent/src/main.ts` - Dispatches CLI inventory actions after runtime creation.
- `packages/coding-agent/src/core/slash-commands.ts` - Registers `/tools` and `/extensions` for autocomplete.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` - Renders inventory output in the TUI chat.

## Tests asserting this spec

- `packages/coding-agent/test/args.test.ts`
- `packages/coding-agent/test/cli-runtime-inventory.test.ts`
- `packages/coding-agent/test/tool-inventory.test.ts`
- `packages/coding-agent/test/tool-inventory-session.test.ts`

## Known gaps (current cycle)

- [ ] Add interactive-mode behavioral tests proving `/tools` and `/extensions` clear the composer and render inventory output.

## Out of scope

- Installed package management remains covered by `pi list`; these commands report runtime-loaded extensions for the current trust and config context.
- Codex-compatible `web.run` search/browse tooling is not implemented by the runtime inventory work; Hostrun supplies approval-gated HTTP helpers, not a web search wrapper.
