# TUI Customization

Module boundary: core TUI configuration plus extension UI surface, not a single first-party extension module.

TUI customization is Pi's native surface for user-controlled terminal presentation and extension-provided UI. The primary user contract is configuration-driven: `[tui]` settings such as `theme = "dracula"`, `strong_color`, `code_color`, and `terminal_resize_reflow_max_rows` must affect the TUI at startup/resume. Extension UI APIs remain part of the same boundary, but live theme switching and live keybinding reload are not current requirements. The contract lives in `packages/coding-agent/src/core/extensions/types.ts` (the `ctx.ui` interface and `registerShortcut`) plus the settings/theme pipeline. How it works belongs in docs/wiki/systems/tui-customization.md.

Target config shape:

```toml
[tui]
theme = "dracula"
strong_color = "#E6B450"
code_color = "#E6B450"
terminal_resize_reflow_max_rows = 5000
```

## What it must do

### TUI config

- [ ] `[tui].theme = "dracula"` selects a named theme at startup/resume, including themes discovered from built-ins, user/project theme dirs, packages, settings, and CLI theme paths.
- [ ] `[tui].strong_color = "#E6B450"` overrides the color used for strong/emphasized terminal text independently of the selected theme.
- [ ] `[tui].code_color = "#E6B450"` overrides inline/fenced code color independently of the selected theme.
- [ ] `[tui].terminal_resize_reflow_max_rows = 5000` caps how many terminal rows Pi reflows after a resize.
- [ ] Invalid theme names or invalid color values fail clearly or fall back predictably; they must not silently leave a half-applied theme.

### Keybindings

- [ ] User keybindings load from `~/.config/pi/agent/keybindings.json` by default, mapping ~50 documented action IDs (e.g. `app.interrupt`, `app.model.select`, `tui.input.submit`) to keys.
- [x] `pi.registerShortcut(key, { description?, handler })` registers an extension shortcut; binding a key that resolves to a reserved built-in action is blocked with a "conflicts with built-in" warning (`extensions-runner.test.ts:129`).
- [x] When a reserved action is removed from the config, a previously-conflicting extension shortcut is allowed (`extensions-runner.test.ts:152`).
- [x] A reserved action wins over a non-reserved action bound to the same key, regardless of iteration order, so extensions stay blocked (`extensions-runner.test.ts:228`; `runner.ts:97-104`).
- [x] Binding a non-reserved built-in key warns but is still allowed (`extensions-runner.test.ts:176`).

### Layout

- [ ] `ctx.ui.setHeader(factory | undefined)` / `setFooter(factory | undefined)` replace the startup header / footer (footer factory receives a `ReadonlyFooterDataProvider`); passing `undefined` restores the built-in.
- [ ] `ctx.ui.setWidget(key, content, options?)` shows a string-array or component widget above/below the editor.
- [ ] `ctx.ui.setEditorComponent(factory | undefined)` replaces the core input editor (subclass `CustomEditor`, call `super.handleInput` for app keybindings); `getEditorComponent()` reads the current factory.
- [ ] `ctx.ui.custom<T>(factory, options?)` shows a full-screen or overlay component with keyboard focus and resolves with a result `T`.
- [ ] `ctx.ui.setTitle`, `setEditorText`/`getEditorText`, `pasteToEditor`, `editor(title, prefill?)`, `addAutocompleteProvider`, and `getToolsExpanded`/`setToolsExpanded` are available as supporting surface.

## How it works

- See docs/wiki/systems/tui-customization.md (stub).
- Existing operator/author docs: `packages/coding-agent/docs/keybindings.md` (~50 action IDs, `~/.config/pi/agent/keybindings.json`), `packages/coding-agent/docs/themes.md` (JSON theme files + resolution order), `packages/coding-agent/docs/extensions.md` (`registerShortcut` ~line 1510), `packages/coding-agent/docs/tui.md`.

## Implementation inventory

- `packages/coding-agent/src/core/extensions/types.ts:163-186` — `setWidget`, `setFooter`, `setHeader`, `setTitle` on the `ctx.ui` interface.
- `packages/coding-agent/src/core/extensions/types.ts:188-203` — `custom<T>(...)` full-screen/overlay component with `done(result)`.
- `packages/coding-agent/src/core/extensions/types.ts:220-256` — `setEditorComponent` / `getEditorComponent` (CustomEditor base, `super.handleInput`).
- `packages/coding-agent/src/core/extensions/types.ts:270-274` — `getToolsExpanded` / `setToolsExpanded`.
- `packages/coding-agent/src/core/extensions/types.ts:1182-1188` — `registerShortcut(shortcut, { description?, handler })`.
- `packages/coding-agent/src/core/extensions/runner.ts:67-85` — `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` (~17 action IDs reserved against extension override).
- `packages/coding-agent/src/core/extensions/runner.ts:89-108` — `buildBuiltinKeybindings`: reserved action wins over non-reserved on key collision.
- `packages/coding-agent/src/core/keybindings.ts:13-202` — app keybinding id inventory plus default app bindings, merged with `@earendil-works/pi-tui` editor/select/input bindings.
- `packages/coding-agent/src/core/keybindings.ts:204-309` — legacy pre-namespaced keybinding migration to namespaced ids.
- `packages/coding-agent/src/core/keybindings.ts:330-368` — `KeybindingsManager.create()` loads `~/.config/pi/agent/keybindings.json` by default and accepts string or string-array bindings.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:411-412` — interactive mode creates the keybindings manager and installs it into the TUI package singleton.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1796-1835` — `ctx.ui.setWidget` implementation: removes an existing widget with the same key from either placement, accepts string arrays or component factories, truncates string widgets after ten lines, and renders above or below the editor.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1838-1864` — extension UI reset clears widgets and restores extension footer/header.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1887-1915` — widget containers are rebuilt from the above/below widget maps.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1920-1948` — `ctx.ui.setFooter` implementation swaps between built-in footer and custom footer, passes the readonly footer data provider, and disposes the previous custom footer.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1953-1991` — `ctx.ui.setHeader` implementation swaps the built-in header, carries expandable state forward, and disposes the previous custom header.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:5559-5570` — `/hotkeys` lists extension-registered shortcuts using the current effective keybinding config.
- `packages/coding-agent/src/core/slash-commands.ts:31` — built-in `/hotkeys` command metadata.
- `packages/coding-agent/src/core/extensions/types.ts:1183-1190` — extension shortcut registration API.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2217-2249` — `ctx.ui.editor` temporary multiline editor wiring and restore behavior.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2256-2319` — `ctx.ui.setEditorComponent` implementation: preserves editor text, forwards submit/change callbacks, copies appearance/autocomplete settings, and restores the default editor when passed `undefined`.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2335-2412` — `ctx.ui.custom` implementation for replacement and overlay UI, including editor restoration, overlay handle exposure, focus handling, and component disposal.
- `packages/coding-agent/src/modes/interactive/theme/theme.ts:323-422` — `Theme` class styling API exposed to extensions through `ctx.ui.theme` and `ctx.ui.getTheme`.
- `packages/coding-agent/src/modes/interactive/theme/theme.ts:428-479` — theme listing combines built-in themes, user custom themes, and registered package/resource themes.
- `packages/coding-agent/src/modes/interactive/theme/theme.ts:613-633` — `loadThemeFromPath` / `getThemeByName` parsing and lookup.
- `packages/coding-agent/src/modes/interactive/theme/theme.ts:772-835` — global current theme proxy, registered-theme map, and `setTheme` failure fallback to `dark`.
- `packages/coding-agent/src/modes/interactive/theme/theme-controller.ts:36-72` — interactive theme application from settings, explicit theme names, and direct `Theme` instances.
- `packages/coding-agent/src/config.ts:396-404` and `:523-526` — built-in theme directory and `~/.config/pi/agent/themes` directory resolution.
- `packages/coding-agent/src/cli/args.ts:201-209` and `packages/coding-agent/src/main.ts:608-611` — CLI `--theme` / `--no-themes` parsing and path resolution.
- `packages/coding-agent/src/core/settings-manager.ts:800-814` and `:1087-1100` — persisted active theme and configured theme path settings.
- `packages/coding-agent/src/core/package-manager.ts:2261-2284`, `:2342-2356`, `:2391-2404`, and `:2465-2490` — resource aggregation for project/user theme directories and settings/package theme paths.
- `packages/tui/src/components/editor.ts` and terminal resize handling — resize reflow behavior and any future `[tui].terminal_resize_reflow_max_rows` cap.

## Tests asserting this spec

- `packages/coding-agent/test/extensions-runner.test.ts:128-313` — shortcut conflict detection: warns on reserved conflict, allows when reserved set changes, reserved wins over non-reserved across iteration order, warns-but-allows on non-reserved built-in.
- `packages/coding-agent/test/interactive-mode-status.test.ts:201-270` — `ctx.ui.custom` overlay/replacement focus regression: an overlay reclaims input after a non-overlay custom UI closes.
- `packages/coding-agent/test/keybindings-migration.test.ts:25-87` — legacy keybinding name migration, namespaced-id precedence, and in-memory loading through `KeybindingsManager.create(agentDir)`.
- `packages/coding-agent/test/theme-picker.test.ts:34-50` — theme listing uses custom theme content names and returns file paths for `getAvailableThemesWithPaths`.
- `packages/coding-agent/test/theme-detection.test.ts:16-133` — terminal background detection, RGB classification, color-mode selection, and automatic light/dark theme setting parsing.
- `packages/coding-agent/test/theme-export.test.ts:18-83` — HTML export theme color derivation and variable resolution.
- `packages/coding-agent/test/suite/regressions/5596-missing-theme-export.test.ts:26-44` — export fallback when a configured theme is missing.

## Known gaps (current cycle)

- No dedicated test proving `[tui].theme = "dracula"` selects a discovered named theme at startup/resume.
- No dedicated test or implementation for `[tui].strong_color` overriding strong/emphasis styling.
- No dedicated test or implementation for `[tui].code_color` overriding inline/fenced code styling.
- No dedicated test or implementation for `[tui].terminal_resize_reflow_max_rows`.
- No dedicated test for `setWidget`; smallest next test slice is a focused `InteractiveMode` private-method regression proving string widgets render above/below editor, same-key replacement disposes/removes the old component across placements, and `undefined` clears the widget.
- No dedicated test for `setHeader`/`setFooter`; both need focused swap/restore/dispose coverage.
- No dedicated test for `setEditorComponent`; it needs focused coverage for text preservation, callback forwarding, and default-editor restore.
- `ctx.ui.custom` has overlay/replacement focus coverage, but no dedicated test for factory rejection restoring the editor or `dispose()` being called on close.

## Out of scope

- The rendering engine / component framework internals (this spec covers the customization API, not the TUI runtime).
- Extension event hooks unrelated to UI — see docs/specs/session-lifecycle-hooks.md and docs/specs/prompt-context-hooks.md.
- Live theme switching and live keybinding reload; startup/resume config correctness is the current requirement.
