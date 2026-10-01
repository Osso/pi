# Project context files

[Contract](../../specs/project-context-files.md).

## Discovery and assembly

[resource-loader.ts](../../../packages/coding-agent/src/core/resource-loader.ts) implements `loadProjectContextFiles`. It resolves cwd and agentDir, constructs cwd ancestors from filesystem root to cwd, and scans the global agent directory followed by those ancestors.

The first pass reads `AGENTS.md`, `AGENTS.local.md`, `AGENTS.MD`, and `AGENTS.local.MD`, in that order within each directory. Any successfully loaded AGENTS-family candidate anywhere selects that family for the entire hierarchy. CLAUDE-family paths are then not accessed. If none loads, a second pass reads the corresponding CLAUDE-family candidates. Selection is based on successful loading, not merely file existence.

Output starts with global instructions. Each ancestor then contributes its selected instructions followed by `docs/local/memory.md`. `appendUniqueContextFiles` deduplicates by real path across the complete output, preserving the first candidate's path and content. Symlinked filename variants therefore do not repeat context.

Project-memory candidates whose target equals the global agent directory's `docs/local/memory.md` are excluded. The filter applies specifically to the project's memory candidate path; an instruction file pointing at the same global file remains eligible.

`DefaultResourceLoader.reload` stores these `{ path, content }` records in `agentsFiles`. [AgentSession](../../../packages/coding-agent/src/core/agent-session.ts) consumes loaded context in its system-prompt inputs; [prompt-context hooks](prompt-context-hooks.md) expose those inputs as `systemPromptOptions.contextFiles`.

## Controls and limits

`noContextFiles` supplies an empty automatic-discovery result. An explicitly supplied `agentsFilesOverride` still receives that result and can replace it. This control is separate from rules, skills, and extension discovery.

Unreadable instruction or memory candidates produce warnings and are skipped. No arbitrary `docs/local/` traversal, descendant-directory scan, or global project-memory loading is implemented. Context-file loading is not gated by project trust; it must not be described as loading only trusted project instructions.

## Test evidence

[resource-loader.test.ts](../../../packages/coding-agent/test/resource-loader.test.ts) contains concrete temporary-file fixtures for hierarchy-wide family selection, ancestor memory placement, global-memory exclusion, symlinked instructions, real-path deduplication, resolved worktree cwd, and `noContextFiles`. Tests inspected, not run. No contract gap identified in this discovery path.
