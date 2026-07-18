# User Rules Loader

Module boundary: core resource-loader/system-prompt feature, not a first-party extension module.

The user-rules-loader feature extends Pi's existing context-file loading so that all `*.md` files under the global agent rules directory (`~/.config/pi/agent/rules/` by default) and optionally `.pi/rules/` (project-local, trust-gated) are read in sorted filename order, trimmed, joined with double newlines, and injected into the system instructions alongside AGENTS.md. Pi already loads AGENTS.md/CLAUDE.md from cwd ancestors and from the global agent directory via `loadProjectContextFiles()` in `packages/coding-agent/src/core/resource-loader.ts` (lines 84–122); this spec only adds the `rules/` subdirectory path. The loader addition belongs in `core/resource-loader.ts`; injection into the prompt belongs in `core/system-prompt.ts`. See [docs/wiki/systems/user-rules-loader.md](../wiki/systems/user-rules-loader.md) for how it works.

## What it must do

### Directory discovery
- [x] Returns no content (does not error) when the global agent `rules/` directory does not exist.
- [x] Loads top-level `rules/*.md` for every runtime.
- [x] Loads `rules/main/*.md` for standalone and orchestrator runtimes.
- [x] Loads `rules/child/*.md` only for child runtimes.
- [x] Observer runtimes load only shared top-level rules unless a caller explicitly overrides rule discovery; the resident Architect uses the `main` scope while retaining its observer execution role.
- [x] Returns no content when the directory exists but contains no non-empty `*.md` files.
- [x] Project-local `.pi/rules/` is only read when the project is trusted (`settingsManager.isProjectTrusted()`); no content is loaded from it for untrusted projects.
- [x] Project-local `.pi/rules/` is silently skipped (not an error) when the directory does not exist or the project is untrusted.

### File loading
- [x] Only `*.md` files are loaded; other extensions in the directory are ignored.
- [x] Files are sorted by filename (lexicographic ascending) before reading, producing deterministic ordering.
- [x] Each file's content is trimmed of leading and trailing whitespace before inclusion.
- [x] Files whose trimmed content is empty are silently skipped.
- [x] Non-empty trimmed contents are joined with a double newline (`\n\n`).

### Load order
- [x] Global shared rules (`~/.config/pi/agent/rules/*.md` by default) are loaded first, followed by the selected runtime scope directory.
- [x] Project-local shared rules (`.pi/rules/*.md`, trust-gated) are appended next, followed by the selected project runtime scope directory.

### System-prompt injection
- [x] The concatenated rules string is injected into the system prompt in `buildSystemPrompt()` (`core/system-prompt.ts`), appended after the existing `<project_instructions>` context-file block.
- [x] When no rules files are found, the system prompt is unmodified (no empty tags or extra whitespace).
- [x] Rules are wrapped in a distinct XML tag (e.g., `<user_rules>...</user_rules>`) to separate them from AGENTS.md content.

### ResourceLoader integration
- [x] `DefaultResourceLoader` calls the rules loader during construction or `reload()` and exposes the result via a `getRulesContent(): string | undefined` method (or equivalent).
- [x] `reload()` re-reads the rules directories so changes take effect without restarting Pi.

## How it works

- [docs/wiki/systems/user-rules-loader.md](../wiki/systems/user-rules-loader.md) (stub — not yet written).

## Implementation inventory

- `packages/coding-agent/src/core/resource-loader.ts` — Loads shared rules plus the selected `main` or `child` scope.
- `packages/coding-agent/src/core/sdk.ts` — Maps runtime roles to rule scopes by default and accepts an explicit rule-scope override.
- `packages/coding-agent/src/core/system-prompt.ts` — Injects loaded rules as a `<user_rules>` block.
- `packages/coding-agent/src/core/agent-session-services.ts` — Passes `rulesContent` from `ResourceLoader` into `buildSystemPrompt` options.
- `packages/coding-agent/src/architect/main.ts` — Selects `main` rules without changing the Architect's observer execution role.

## Tests asserting this spec

- `packages/coding-agent/test/resource-loader.test.ts` — sorted global rules, scoped loading, markdown-only filtering, empty-file skip, global/project merge order, and project trust gating.
- `packages/coding-agent/test/system-prompt.test.ts` — `<user_rules>` injection after project context and no empty tags when no rules content exists.
- `packages/coding-agent/test/architect-service.test.ts` — resident Architect `main`-scope override and ordinary observer shared-only behavior.

## Known gaps (current cycle)

- [x] Implement `loadRulesFromDir(dirPath: string): string | undefined` in `resource-loader.ts`: glob `*.md`, sort, read, trim, skip-empty, join with `\n\n`.
- [x] Wire global rules load: `loadRulesFromDir(join(agentDir, "rules"))`.
- [x] Wire project-local rules load: `loadRulesFromDir(join(cwd, CONFIG_DIR_NAME, "rules"))` gated on `settingsManager.isProjectTrusted()`.
- [x] Merge global + local with global first; store on `DefaultResourceLoader`.
- [x] Extend `BuildSystemPromptOptions` with `rulesContent?: string` and inject `<user_rules>` block in `buildSystemPrompt()`.
- [x] Pass `rulesContent` through from `createAgentSessionServices` → `buildSystemPrompt`.
- [x] Add `rules` directory name to `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES` in `trust-manager.ts` (or verify it is implicitly covered).
- [x] Write unit tests: no-dir returns undefined, empty-dir returns undefined, sorts correctly, skips empty files, project-local gated by trust.

## Out of scope

- TOML, YAML, or non-markdown rule file formats.
- Watching the rules directory for live changes (reload on file change); `reload()` on demand is sufficient.
- Per-extension or per-skill rule scoping.
- Additional runtime scopes beyond shared, main, and child rules.
