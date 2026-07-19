# Runtime inventory commands

Module boundary: core CLI/TUI diagnostic surface, not a first-party extension module.

Runtime inventory commands expose what Pi actually loaded for the current startup context. The CLI actions and TUI slash commands are diagnostic surfaces for tools and extensions, so users can verify whether features such as multi-agent tools are available before relying on a model answer.

## What it must do

### Tool inventory

- [x] `pi tools` must parse as a metadata action, not as a prompt message.
- [x] `/tools` must be a built-in slash command.
- [x] Tool inventory output must include every configured tool, whether each tool is active, its source, and its description.
- [x] Tool inventory output must keep terminal table lines compact by truncating long descriptions.
- [x] Tool inventory output must show an explicit empty state when no tools are available.
- [x] Default coding sessions must keep the read-only discovery tools `grep`, `find`, and `ls` active alongside editing tools.
- [x] Tool inventory data must include tools registered by extensions during `session_start`.
- [x] Tool inventory data must include default first-party runtime tools such as `spawn_agent` and `manage_goal`.

### Extension inventory

- [x] `pi extensions` must parse as a metadata action, not as a prompt message.
- [x] `/extensions` must be a built-in slash command.
- [x] Extension inventory output must include every loaded extension, its scope/source, and registered command/tool/handler counts.
- [x] Extension inventory output must show an explicit empty state when no extensions are loaded.
- [x] Extension inventory output must include built-in first-party runtime extensions such as `approval-controls`, `goal`, `agents-core`, `agent-viewer`, `agents-mailbox`, and `run-plan` even while project trust is being resolved.

## How it works

- [ ] See [`docs/wiki/systems/runtime-inventory.md`](../wiki/systems/runtime-inventory.md).

## Implementation inventory

- `packages/coding-agent/src/cli/args.ts` - Parses `tools` and `extensions` metadata actions.
- `packages/coding-agent/src/cli/list-tools.ts` - Formats and prints current tool inventory.
- `packages/coding-agent/src/cli/list-extensions.ts` - Formats and prints current extension inventory.
- `packages/coding-agent/src/core/tools/index.ts` - Defines built-in tool names and the default active tool set.
- `packages/coding-agent/src/core/sdk.ts` - Applies default active tools when creating a session.
- `packages/coding-agent/src/core/system-prompt.ts` - Uses default active tools when building prompt text without an explicit tool selection.
- `packages/coding-agent/src/core/resource-loader.ts` - Preserves first-party synthetic extensions through project trust reload.
- `packages/coding-agent/src/main.ts` - Dispatches CLI inventory actions after runtime creation.
- `packages/coding-agent/src/core/slash-commands.ts` - Registers `/tools` and `/extensions` for autocomplete.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` - Renders inventory output in the TUI chat.

## Tests asserting this spec

- `packages/coding-agent/test/args.test.ts`
- `packages/coding-agent/test/cli-runtime-inventory.test.ts`
- `packages/coding-agent/test/system-prompt.test.ts`
- `packages/coding-agent/test/tool-inventory.test.ts`
- `packages/coding-agent/test/tool-inventory-session.test.ts`
- `packages/coding-agent/test/suite/regressions/5109-exclude-tools.test.ts`

## Known gaps (current cycle)

- [ ] Add interactive-mode behavioral tests proving `/tools` and `/extensions` clear the composer and render inventory output.

## Out of scope

- Installed package management remains covered by `pi list`; these commands report runtime-loaded extensions for the current trust and config context.
- Codex-compatible `web.run` search/browse tooling is not implemented by the runtime inventory work.
