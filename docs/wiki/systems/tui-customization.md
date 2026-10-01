# TUI customization

Contract: [TUI customization](../../specs/tui-customization.md).

## Configuration that works today

Pi currently reads JSON settings, not the contract's target TOML `[tui]` section. Configure a named theme as `{"theme":"my-theme"}` in agent/project `settings.json`; [`settings-manager.ts`](../../../packages/coding-agent/src/core/settings-manager.ts) supplies it to [`InteractiveThemeController`](../../../packages/coding-agent/src/modes/interactive/theme/theme-controller.ts). [`theme.ts`](../../../packages/coding-agent/src/modes/interactive/theme/theme.ts) resolves discovered/built-in themes and provides styling. Failed named-theme application restores `dark` and reports the error.

[`KeybindingsManager`](../../../packages/coding-agent/src/core/keybindings.ts) reads `keybindings.json` under the resolved [agent directory](../../../packages/coding-agent/src/config.ts), normally `~/.config/pi/agent/`. Values are a key string or array, overriding namespaced action defaults. Legacy IDs migrate. [`extensions/runner.ts`](../../../packages/coding-agent/src/core/extensions/runner.ts) blocks reserved shortcut conflicts, warns but permits non-reserved conflicts, and gives reserved actions precedence on duplicate keys. Interactive interrupt handling ignores key releases and leaves a dialog's cancel key with the focused component.

**Unimplemented:** TOML `[tui].theme`, `strong_color`, `code_color`, and `terminal_resize_reflow_max_rows`. Existing JSON theme selection and Markdown theme colors are not implementations of those independent overrides.

## Extension UI and rendering

[`ExtensionUIContext`](../../../packages/coding-agent/src/core/extensions/types.ts) defines the API; [`InteractiveMode`](../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) implements it:

- `setWidget(key, content, {placement})` accepts lines or a component factory above/below the editor. Replacement removes/disposes the same key from either placement; string widgets truncate after ten lines; `undefined` clears.
- `setHeader`/`setFooter` swap components and dispose predecessors. Footer factories receive readonly footer data. Clearing a custom footer restores the default extension footer when present, otherwise the built-in footer.
- `setEditorComponent` preserves text and forwards submit/change, appearance, and autocomplete settings. `undefined` restores the default editor. Extend `CustomEditor` and delegate unhandled keys to `super.handleInput`.
- `custom(factory, options)` temporarily owns focus through replacement or overlay UI and resolves through `done(result)`. Text/title, temporary editor, autocomplete, and tool-expansion helpers supplement it.

[`interactive-root-compositor.ts`](../../../packages/coding-agent/src/modes/interactive/interactive-root-compositor.ts) separates normal transcript flow from bottom-anchored status/widgets/editor/footer. [`working-editor.ts`](../../../packages/coding-agent/src/modes/interactive/working-editor.ts) enables prompt-cell animation only for compatible editors and one-cell frames; unsupported editors/wider frames keep static status text. [`tui.ts`](../../../packages/tui/src/tui.ts) handles safe full-width region updates and fixed-cell placement. Rendered component lines must fit the supplied width; theme-dependent caches must rebuild on invalidation.

Component factories are TUI-only. RPC supports selected dialogs/text updates, not custom TUI components; print/JSON UI methods are generally inert. Use `ctx.mode === "tui"`, not merely `ctx.hasUI`, for component APIs.

## Test locations and limits

[`extensions-runner.test.ts`](../../../packages/coding-agent/test/extensions-runner.test.ts) covers shortcut conflicts; [`keybindings-migration.test.ts`](../../../packages/coding-agent/test/keybindings-migration.test.ts) covers config migration. [`interactive-mode-status.test.ts`](../../../packages/coding-agent/test/interactive-mode-status.test.ts) covers overlay focus, dialog cancellation, and release filtering. [`interactive-mode-working-editor.test.ts`](../../../packages/coding-agent/test/interactive-mode-working-editor.test.ts) covers main/child animation and incompatible editors. [`root-compositor.test.ts`](../../../packages/tui/test/root-compositor.test.ts), [`render-region.test.ts`](../../../packages/tui/test/render-region.test.ts), and [`fixed-cell.test.ts`](../../../packages/tui/test/fixed-cell.test.ts) cover layout/partial-render behavior.

Implemented widget/header/footer/editor swaps lack the dedicated swap/disposal coverage identified in the contract; API existence is not that test proof. Tests were inspected, not executed.

Author references: [TUI](../../../packages/coding-agent/docs/tui.md), [extensions](../../../packages/coding-agent/docs/extensions.md), [themes](../../../packages/coding-agent/docs/themes.md), [keybindings](../../../packages/coding-agent/docs/keybindings.md).
