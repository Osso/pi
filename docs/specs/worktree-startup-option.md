# Worktree Startup Option

The `-w`/`--worktree <NAME>` CLI flag creates or reuses a sibling Git worktree before the session starts, letting fork work begin in an isolated checkout without manual `git worktree` setup. When supplied, `main()` in `packages/coding-agent/src/main.ts` resolves the worktree path and sets the effective `cwd` passed to `createAgentSessionServices()` before any session or resource loading begins. New worktrees are created from `origin/main` (falling back to `origin/master` if `origin/main` does not exist). Worktree lifecycle logic will be isolated in a new utility module. Planned changes touch `packages/coding-agent/src/cli/args.ts` (flag parsing) and `packages/coding-agent/src/main.ts` (resolution and cwd override). See [docs/wiki/systems/worktree-startup-option.md](../wiki/systems/worktree-startup-option.md) for how it works.

## What it must do

### CLI surface
- [ ] `-w <NAME>` and `--worktree <NAME>` are accepted by `parseArgs()` in `cli/args.ts` and stored on the `Args` object.
- [ ] The flag is documented in `printHelp()` output.
- [ ] Passing `-w` without a value is a parse error reported via `args.diagnostics`.

### Worktree resolution
- [ ] If a sibling worktree directory named `<NAME>` already exists (detected via `git worktree list`), it is reused without re-creating.
- [ ] If no such worktree exists, `git worktree add <sibling-path>/<NAME> origin/main` is executed; if `origin/main` does not exist, `origin/master` is used as the fallback.
- [ ] If neither `origin/main` nor `origin/master` exists, a visible error is shown and the session does not start.
- [ ] The worktree is created as a sibling of the repo root (e.g., if the repo is at `/home/user/project`, the worktree is at `/home/user/project-<NAME>`).
- [ ] Resolution runs before any resource loading or session creation so the correct cwd is used throughout.

### Session cwd override
- [ ] The resolved worktree path is passed as the `cwd` option to `createAgentSessionServices()`.
- [ ] All context-file loading (AGENTS.md hierarchy, `.pi/rules/`, etc.) uses the worktree cwd, not the original cwd.
- [ ] The working directory shown in the system prompt reflects the worktree path.

### Error handling
- [ ] If `git` is not available or the current directory is not inside a Git repository, a clear error is shown and the session does not start.
- [ ] If worktree creation fails (e.g., `NAME` conflicts with an existing branch in a way Git rejects), the Git error output is surfaced to the user.

## How it works

- [docs/wiki/systems/worktree-startup-option.md](../wiki/systems/worktree-startup-option.md) (stub — not yet written).

## Implementation inventory

- `packages/coding-agent/src/cli/args.ts` (existing) — Add `-w`/`--worktree` parsing to `parseArgs()` and the `Args` interface; document in `printHelp()`.
- `packages/coding-agent/src/utils/git-worktree.ts` (planned) — `resolveWorktree(name: string, repoRoot: string): Promise<string>`: checks for existing worktree, creates from `origin/main` or `origin/master`, returns absolute path.
- `packages/coding-agent/src/main.ts` (existing) — After `parseArgs()`, if `args.worktree` is set: find repo root, call `resolveWorktree()`, override `cwd` before passing to `createAgentSessionServices()`.

## Tests asserting this spec

(none yet — feature unimplemented)

## Known gaps (current cycle)

- [ ] Add `worktree?: string` to the `Args` interface in `cli/args.ts`.
- [ ] Parse `-w`/`--worktree <NAME>` in `parseArgs()`; add diagnostic on missing value.
- [ ] Document in `printHelp()`.
- [ ] Implement `packages/coding-agent/src/utils/git-worktree.ts` with `resolveWorktree()`: shell out to `git rev-parse --show-toplevel`, `git worktree list --porcelain`, and `git worktree add`.
- [ ] Wire into `main.ts`: resolve worktree if `args.worktree` is set, override `cwd`.
- [ ] Write unit tests for `resolveWorktree`: existing worktree reused, new worktree created from `origin/main`, fallback to `origin/master`, error on missing remote.

## Out of scope

- Automatic worktree deletion on session exit.
- Support for local branch refs as the base (only `origin/main` and `origin/master` are supported).
- Worktree management subcommands (`pi worktree list`, `pi worktree remove`).
