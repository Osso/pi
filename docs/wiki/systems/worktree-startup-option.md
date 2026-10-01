# Worktree startup option

Contract: [Worktree startup option](../../specs/worktree-startup-option.md).

## Usage and resolution

`pi --worktree feature` (or `pi -w feature`) creates/reuses `<repository-basename>-feature` beside the repository root. For `/home/user/project`, the target is `/home/user/project-feature`; it is not an arbitrary worktree root or a `.worktrees` directory.

[`parseArgs()`](../../../packages/coding-agent/src/cli/args.ts) stores the next argument in `Args.worktree` and emits `--worktree requires a value` when no argument follows. Help documents both flags.

[`resolveWorktree()`](../../../packages/coding-agent/src/utils/git-worktree.ts) uses argv-based Git execution:

1. Resolve the repository root with `rev-parse --show-toplevel`, including when startup cwd is a subdirectory.
2. Read `worktree list --porcelain`; reuse only a registered worktree whose path exactly equals the computed target.
3. Verify `origin/main`, then `origin/master` if main verification fails; error when neither verifies.
4. Run `worktree add <target> <base-ref>` and return the target path.

[`main.ts`](../../../packages/coding-agent/src/main.ts) changes its effective cwd before cwd-bound migrations/settings and session runtime/service creation. Resource loading, relative tools, and generated working-directory context therefore use that cwd for a new worktree session. Resolution errors print `Error: ...` and exit before runtime creation; `WorktreeStartupError` preserves Git stderr, then stdout/message when stderr is empty.

## Limits

The resolver does not fetch remote refs, accept a configurable base, delete worktrees on exit, or expose list/remove subcommands. Reuse is based on Git's registered path, not merely an existing directory or matching branch name. Creation passes the remote ref directly without an explicit `-b <NAME>` branch option; NAME names the sibling path, not an explicitly requested branch.

Parsing consumes any following token as the value; it does not separately validate NAME or reject a following option token. Git/path behavior decides creation failures. Combining this option with resume/session selection can subsequently select another session's cwd through normal startup selection; the flag does not rewrite an existing session's directory.

## Test locations

[`args.test.ts`](../../../packages/coding-agent/test/args.test.ts) checks both spellings and absent-value diagnostics. [`git-worktree.test.ts`](../../../packages/coding-agent/test/git-worktree.test.ts) uses injected Git results for exact-path reuse, sibling construction, base selection, and stderr errors; it is not a real-Git integration test. [`worktree-startup.test.ts`](../../../packages/coding-agent/test/worktree-startup.test.ts) mocks resolution/runtime creation to check ordering, service cwd, and early exit. [`resource-loader.test.ts`](../../../packages/coding-agent/test/resource-loader.test.ts) checks worktree-local context/rules; [`system-prompt.test.ts`](../../../packages/coding-agent/test/system-prompt.test.ts) checks the supplied cwd in prompt text.

Tests were inspected, not executed. Reference: [SDK cwd/resource loading](../../../packages/coding-agent/docs/sdk.md).
