# TUI Customization

TUI customization is Pi's native surface for users and extensions to reshape the terminal UI: switch and define themes, rebind ~50 keyboard actions and register extension shortcuts (with reserved-key conflict protection), and replace layout regions (header, footer, widgets) or the input editor itself. Unlike a fork that hard-codes a handful of color knobs and key remaps, Pi exposes a typed `ctx.ui` API plus user-editable JSON config. The contract lives in `packages/coding-agent/src/core/extensions/types.ts` (the `ctx.ui` interface and `registerShortcut`) and the reserved-key set in `packages/coding-agent/src/core/extensions/runner.ts`. How it works belongs in docs/wiki/systems/tui-customization.md.

## What it must do

### Themes

- [ ] `ctx.ui.getAllThemes()` lists available themes with name and (optional) file path; `getTheme(name)` loads one without switching; `setTheme(string | Theme)` switches the active theme and returns `{ success, error? }`.
- [ ] `ctx.ui.theme` exposes the current `Theme` (read-only) for styling custom components.
- [ ] Themes resolve from built-in set, `~/.pi/agent/themes/`, `.pi/themes/`, packages, settings, and CLI (per themes.md), as JSON theme files.

### Keybindings

- [ ] User keybindings load from `~/.pi/agent/keybindings.json`, mapping ~50 documented action IDs (e.g. `app.interrupt`, `app.model.select`, `tui.input.submit`) to keys.
- [ ] `/reload` re-applies the keybindings config live without restart.
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
- Existing operator/author docs: `packages/coding-agent/docs/keybindings.md` (~50 action IDs, `~/.pi/agent/keybindings.json`, `/reload`), `packages/coding-agent/docs/themes.md` (JSON theme files + resolution order), `packages/coding-agent/docs/extensions.md` (`registerShortcut` ~line 1510, `setTheme`/`getAllThemes`/`getTheme` ~line 2339), `packages/coding-agent/docs/tui.md`.

## Implementation inventory

- `packages/coding-agent/src/core/extensions/types.ts:163-186` — `setWidget`, `setFooter`, `setHeader`, `setTitle` on the `ctx.ui` interface.
- `packages/coding-agent/src/core/extensions/types.ts:188-203` — `custom<T>(...)` full-screen/overlay component with `done(result)`.
- `packages/coding-agent/src/core/extensions/types.ts:220-256` — `setEditorComponent` / `getEditorComponent` (CustomEditor base, `super.handleInput`).
- `packages/coding-agent/src/core/extensions/types.ts:258-268` — `theme` (readonly), `getAllThemes`, `getTheme`, `setTheme`.
- `packages/coding-agent/src/core/extensions/types.ts:270-274` — `getToolsExpanded` / `setToolsExpanded`.
- `packages/coding-agent/src/core/extensions/types.ts:1182-1188` — `registerShortcut(shortcut, { description?, handler })`.
- `packages/coding-agent/src/core/extensions/runner.ts:67-85` — `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` (~17 action IDs reserved against extension override).
- `packages/coding-agent/src/core/extensions/runner.ts:89-108` — `buildBuiltinKeybindings`: reserved action wins over non-reserved on key collision.
- `packages/coding-agent/src/core/keybindings.ts:13-202` — app keybinding id inventory plus default app bindings, merged with `@earendil-works/pi-tui` editor/select/input bindings.
- `packages/coding-agent/src/core/keybindings.ts:204-309` — legacy pre-namespaced keybinding migration to namespaced ids.
- `packages/coding-agent/src/core/keybindings.ts:330-368` — `KeybindingsManager.create()` loads `~/.pi/agent/keybindings.json`, accepts string or string-array bindings, and `reload()` re-reads the same file into user bindings.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:411-412` — interactive mode creates the keybindings manager and installs it into the TUI package singleton.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:5091-5140` — `/reload` handler reloads the session/resources, then calls `this.keybindings.reload()` before rebuilding interactive UI state.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:5559-5570` — `/hotkeys` lists extension-registered shortcuts using the current effective keybinding config.
- `packages/coding-agent/src/core/slash-commands.ts:31` and `:41` — built-in `/hotkeys` and `/reload` command metadata.
- `packages/coding-agent/src/core/extensions/types.ts:1183-1190` — extension shortcut registration API.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2062-2078` — live interactive `ctx.ui` theme surface: readonly `theme`, `getAllThemes`, `getTheme`, and `setTheme`; string themes persist through `SettingsManager.setTheme`, `Theme` instances apply without persisting a settings name.
- `packages/coding-agent/src/modes/interactive/theme/theme.ts:323-422` — `Theme` class styling API exposed to extensions through `ctx.ui.theme` and `ctx.ui.getTheme`.
- `packages/coding-agent/src/modes/interactive/theme/theme.ts:428-479` — theme listing combines built-in themes, user custom themes, and registered package/resource themes.
- `packages/coding-agent/src/modes/interactive/theme/theme.ts:613-633` — `loadThemeFromPath` / `getThemeByName` parsing and lookup.
- `packages/coding-agent/src/modes/interactive/theme/theme.ts:772-835` — global current theme proxy, registered-theme map, and `setTheme` failure fallback to `dark`.
- `packages/coding-agent/src/modes/interactive/theme/theme-controller.ts:36-72` — interactive theme application from settings, explicit theme names, and direct `Theme` instances.
- `packages/coding-agent/src/config.ts:396-404` and `:523-526` — built-in theme directory and `~/.pi/agent/themes` directory resolution.
- `packages/coding-agent/src/cli/args.ts:201-209` and `packages/coding-agent/src/main.ts:608-611` — CLI `--theme` / `--no-themes` parsing and path resolution.
- `packages/coding-agent/src/core/settings-manager.ts:800-814` and `:1087-1100` — persisted active theme and configured theme path settings.
- `packages/coding-agent/src/core/package-manager.ts:2261-2284`, `:2342-2356`, `:2391-2404`, and `:2465-2490` — resource aggregation for project/user theme directories and settings/package theme paths.

## Tests asserting this spec

- `packages/coding-agent/test/extensions-runner.test.ts:128-313` — shortcut conflict detection: warns on reserved conflict, allows when reserved set changes, reserved wins over non-reserved across iteration order, warns-but-allows on non-reserved built-in.
- `packages/coding-agent/test/keybindings-migration.test.ts:25-87` — legacy keybinding name migration, namespaced-id precedence, and in-memory loading through `KeybindingsManager.create(agentDir)`.
- `packages/coding-agent/test/theme-picker.test.ts:34-50` — theme listing uses custom theme content names and returns file paths for `getAvailableThemesWithPaths`.
- `packages/coding-agent/test/theme-detection.test.ts:16-133` — terminal background detection, RGB classification, color-mode selection, and automatic light/dark theme setting parsing.
- `packages/coding-agent/test/theme-export.test.ts:18-83` — HTML export theme color derivation and variable resolution.
- `packages/coding-agent/test/suite/regressions/5596-missing-theme-export.test.ts:26-44` — export fallback when a configured theme is missing.

## Known gaps (current cycle)

- No dedicated test for the interactive extension theme API (`ctx.ui.theme`, `ctx.ui.setTheme`, `ctx.ui.getAllThemes`, `ctx.ui.getTheme`) through a real extension context; existing theme tests cover lower-level discovery/loading, not the `ctx.ui` extension surface.
- No dedicated test proving `ctx.ui.setTheme("name")` persists the string setting while `ctx.ui.setTheme(themeInstance)` applies without writing a theme name to settings.
- No dedicated test proving project `.pi/themes`, settings `themes`, package themes, and CLI `--theme` entries appear through the extension-facing `ctx.ui.getAllThemes()` path.
- No dedicated test for `setHeader`/`setFooter`/`setWidget` or `setEditorComponent`/`custom`.
- No dedicated test proving `KeybindingsManager.reload()` re-reads a changed `~/.pi/agent/keybindings.json` and updates the effective config.
- No dedicated interactive-mode test proving `/reload` re-applies changed keybindings live without restarting the process.

## Out of scope

- The rendering engine / component framework internals (this spec covers the customization API, not the TUI runtime).
- Extension event hooks unrelated to UI — see docs/specs/session-lifecycle-hooks.md and docs/specs/prompt-context-hooks.md.
