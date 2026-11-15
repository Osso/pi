# User rules loader

Contract: [User rules loader](../../specs/user-rules-loader.md).

## Discovery and prompt flow

[`DefaultResourceLoader.reload()`](../../../packages/coding-agent/src/core/resource-loader.ts) reads rules separately from project context files. [`getAgentDir()`](../../../packages/coding-agent/src/config.ts) normally resolves `~/.config/pi/agent/`, honoring XDG configuration and `PI_CODING_AGENT_DIR` overrides.

Load order is global `rules/*.md`, global selected-scope `rules/<scope>/*.md`, then trusted cwd-local `.pi/rules/*.md` and its selected-scope directory. Shared-only scope omits scope subdirectories. Project rules are read only when `settingsManager.isProjectTrusted()`; this is cwd-local discovery, not ancestor rules discovery.

`loadRulesFilesFromDir()` lists direct entries ending in lowercase `.md`, sorts with `localeCompare`, reads and trims each body, and discards empty bodies. Missing/non-directory rule paths return no files. `getRulesFiles()` exposes paths/content; `getRulesContent()` joins bodies with double newlines or returns undefined. Reload rereads disk; construction initializes empty results before reload.

[`rules-scope.ts`](../../../packages/coding-agent/src/core/rules-scope.ts) maps each scope to its subdirectories: `main` → `main/`, `sub-agent` → `sub-agent/`, `supervisor` → `main/` then `supervisor/`, `shared` → none. [`sdk.ts`](../../../packages/coding-agent/src/core/sdk.ts) selects `sub-agent` for child runtimes, `shared` for observers (including the resident Architect), and otherwise `mainSessionRulesScope()`: `supervisor` when `supervisor.sessionId` in settings equals the session ID, else `main`. The CLI builds its loader in [`main.ts`](../../../packages/coding-agent/src/main.ts) and calls `mainSessionRulesScope()` for every runtime it creates, so a session switch or restart re-evaluates the scope. `createAgentSession({rulesScope})` overrides the default when constructing its default loader. A caller-supplied loader owns its discovery.

[`AgentSession._rebuildSystemPrompt()`](../../../packages/coding-agent/src/core/agent-session.ts) passes loaded rules to [`buildSystemPrompt()`](../../../packages/coding-agent/src/core/system-prompt.ts). Both custom and default prompt paths append nonempty `<user_rules>` after project context and before skill metadata. Empty rules produce no wrapper.

## Context files and limits

See [project context files](project-context-files.md) for instruction-file precedence, hierarchy ordering, deduplication, and project-memory loading.

Rules are not context files: `noContextFiles` suppresses instruction/memory discovery, not rules discovery. The loader does not recursively scan arbitrary rule subdirectories, watch changes, parse frontmatter, resolve rule conflicts, or support non-Markdown formats. Read failures inside existing rule directories propagate; only absent paths and empty content are silently skipped.

## Test locations

[`resource-loader.test.ts`](../../../packages/coding-agent/test/resource-loader.test.ts) contains fixtures for AGENTS precedence, ordering/deduplication, sorted Markdown bodies, scopes, trust, empty/missing directories, worktree cwd, and disk reload. [`system-prompt.test.ts`](../../../packages/coding-agent/test/system-prompt.test.ts) asserts wrapper placement and absence of empty tags. [`rules-scope.test.ts`](../../../packages/coding-agent/test/rules-scope.test.ts) checks Supervisor, main, and sub-agent selection; [`supervisor-rules-scope.test.ts`](../../../packages/coding-agent/test/suite/regressions/supervisor-rules-scope.test.ts) checks it in a real Pi process; [`architect-service.test.ts`](../../../packages/coding-agent/test/architect-service.test.ts) checks shared-only observers.

References: [SDK resource loading](../../../packages/coding-agent/docs/sdk.md), [project trust settings](../../../packages/coding-agent/docs/settings.md). Tests were inspected, not executed.
