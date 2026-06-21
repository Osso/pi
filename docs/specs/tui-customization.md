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

## Tests asserting this spec

- `packages/coding-agent/test/extensions-runner.test.ts:128-313` — shortcut conflict detection: warns on reserved conflict, allows when reserved set changes, reserved wins over non-reserved across iteration order, warns-but-allows on non-reserved built-in.

## Known gaps (current cycle)

- No dedicated test for the theme API (`setTheme`/`getAllThemes`/`getTheme`); existing theme tests cover discovery/loading, not the `ctx.ui` extension surface.
- No dedicated test for `setHeader`/`setFooter`/`setWidget` or `setEditorComponent`/`custom`.
- No dedicated test for live `/reload` re-applying keybindings.

## Out of scope

- The rendering engine / component framework internals (this spec covers the customization API, not the TUI runtime).
- Extension event hooks unrelated to UI — see docs/specs/session-lifecycle-hooks.md and docs/specs/prompt-context-hooks.md.
