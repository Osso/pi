# Pi feature specs

This directory holds one spec per feature, describing **what** each feature must do (the
contract). How a feature works belongs in `docs/wiki/systems/<feature>.md` (stubs, written
later). Specs are tracked in git; add or update a feature's spec in the same commit as its code.
Each feature spec starts with a `Module boundary:` line saying whether the feature is a
first-party extension module, a core subsystem, or an extension API contract.

These specs were seeded by transposing the behavioral features of the Osso `codex` fork
(`~/Repos/codex/docs/specs/`) onto Pi. Pi's native extension system already provides most of
codex's hook-style features, so each transposed feature falls into one of three buckets:

- **NATIVE** — Pi already provides the capability via its extension API; the spec documents the
  existing contract and cites real source. Build work is limited to closing test gaps.
- **BUILD** — a genuine gap in Pi; the spec describes the target contract and all bullets are
  `- [ ]` until implemented and tested.
- **DROP** (not specced) — codex-internal or upstream-divergence housekeeping with no meaning in
  Pi; recorded below for traceability so the triage decision is not re-litigated.

## Feature → spec map

| Feature | Spec | Status | Notes |
|---|---|---|---|
| Goal system (`/goal`) | [`goal-system.md`](goal-system.md) | **BUILD** (primary) | Codex-style long-running objective with set/view/clear, persistence, context injection, and autonomous continuation. |
| `/run-plan` command | [`run-plan-command.md`](run-plan-command.md) | **BUILD** | Trivial via `pi.registerCommand`; walks `PLAN.md`. |
| User rules loader (`rules/*.md`) | [`user-rules-loader.md`](user-rules-loader.md) | **BUILD** (additive) | Pi already loads AGENTS.md/CLAUDE.md hierarchy; adds global agent `rules/` + project `.pi/rules/`. |
| Project context files | [`project-context-files.md`](project-context-files.md) | **NATIVE** | Global/cwd instruction-file hierarchy plus cwd-ancestor `docs/local/memory.md` project context. |
| Worktree startup (`-w/--worktree`) | [`worktree-startup-option.md`](worktree-startup-option.md) | **BUILD** | New CLI flag; create/reuse sibling git worktree. |
| MCP-delegated permission prompt | [`permission-prompt-tool.md`](permission-prompt-tool.md) | **BUILD** | Claude-Code `--permission-prompt-tool` wire compat; falls back to native interactive gate. |
| Approval policy presets | [`approval-system.md`](approval-system.md) | **BUILD** | Core `on-request`/`never`/`auto-approve` enforcement plus first-party `approval-controls` extension for `/approvals` `/sandbox`, layered on the native `tool_call` reviewer. |
| Loop tool (`loop`, `/loop`) | [`loop-tool.md`](loop-tool.md) | **NATIVE** | First-party extension for recurring follow-up prompts in the current session. |
| Slash-command dispatch | [`slash-commands.md`](slash-commands.md) | **NATIVE** | Built-in, extension, skill, and prompt-template command resolution, including unknown-command rejection. |
| Safe mode (`/safe`) | [`safe-mode.md`](safe-mode.md) | **BUILD** (done) | First-party session-local tool-call allowlist allowing only `web_search` and `ask_questions` while enabled. |
| Native subagent / multi-agent + inter-agent messaging | [`multi-agent.md`](multi-agent.md) | **BUILD** (planned) | Authoritative core state, read-only TUI projections, mailbox steering, agent viewer/mailbox extensions, account-governed budgets/permissions. |
| Headless Pi integration fixture | [`headless-pi-test-fixture.md`](headless-pi-test-fixture.md) | **BUILD** | Disposable real-process RPC fixture with isolated state, private faux-provider control, multi-agent/mailbox assertions, and session-recovery scenarios. |
| Tool backgrounding | [`tool-backgrounding.md`](tool-backgrounding.md) | **BUILD** (done) | Shared detach registry with bash and Pyrun background job tracking. |
| Pyrun console streaming | [`pyrun-console-streaming.md`](pyrun-console-streaming.md) | **BUILD** (done) | Ordered line-buffered stdout/stderr JSONL events with retained final console history. |
| Runtime inventory commands | [`runtime-inventory.md`](runtime-inventory.md) | **BUILD** | `pi tools`/`pi extensions` plus `/tools`/`/extensions` for current tool and extension visibility. |
| Web search tool | [`web-search-tool.md`](web-search-tool.md) | **BUILD** | First-party `web_search` tool backed by OpenAI Responses hosted search; no legacy web-search flag. |
| Bubblewrap sandbox backend | [`bwrap-sandbox.md`](bwrap-sandbox.md) | **BUILD** | Linux `bwrap` backend for routing tool workers through sandbox profiles while leaving host Pi outside. |
| Resident Architect service | [`architect-service.md`](architect-service.md) | **BUILD** (done) | Systemd-supervised, event-driven Sol advisor that observes shared Pi state without dispatching or remediating. |
| Resident Supervisor service | [`supervisor-service.md`](supervisor-service.md) | **BUILD** (done) | Systemd-supervised, event-driven Sol policy engine for LLM approvals and goal completion/continuation decisions. |
| Prompt / context injection | [`prompt-context-hooks.md`](prompt-context-hooks.md) | **NATIVE** | `before_agent_start` / `context` / `before_provider_request` / `session_start`. |
| PreToolUse command rewrites | [`pre-tool-use-rewrites.md`](pre-tool-use-rewrites.md) | **NATIVE** | `tool_call` mutates `input` in place + `{block}`; `tool_result`. |
| Session lifecycle hooks | [`session-lifecycle-hooks.md`](session-lifecycle-hooks.md) | **NATIVE** | 8 session events + `resources_discover` + `project_trust`, with cancel/replace semantics. |
| Resume session tool (`resume_session`) | [`resume-session-tool.md`](resume-session-tool.md) | **BUILD** (done) | Built-in tool for explicit main-thread session replacement with optional starter prompt. |
| Current session history search (`search_current_session_history`) | [`current-session-history-search.md`](current-session-history-search.md) | **BUILD** (done) | Active-branch search across conversational entries, including content omitted by compaction. |
| Session directory tools (`list_sessions`, `broadcast`) | [`session-directory-tools.md`](session-directory-tools.md) | **BUILD** (done) | Heartbeat-backed current-session inventory, eligibility, and message fanout. |
| Session archive state | [`session-archive.md`](session-archive.md) | **BUILD** (done) | Control-DB archive state, Archived picker scope, Ctrl+A selected-session archive, age-based archive CLI, and first-party `/archive` current-session archive. |
| Session selector search | [`session-selector-search.md`](session-selector-search.md) | **NATIVE** | Resume-picker phrase and regex search with literal-first fuzzy fallback, relevance ranking, and named-session filtering. |
| Shared channel (`channel_post`) | [`shared-channel.md`](shared-channel.md) | **BUILD** (done) | Single SQLite-backed global coordination log with per-session cursors and idle drain delivery. |
| Compaction length-retry | [`compaction-length-retry.md`](compaction-length-retry.md) | **BUILD** (done) | Threshold auto-compaction resumes a `"length"`-truncated turn once instead of idling. |
| Codex paired-provider quota fallback | [`codex-quota-fallback.md`](codex-quota-fallback.md) | **BUILD** | On terminal Codex quota/billing exhaustion, continue once through an authenticated paired provider with the same model ID; fallback stays session-local and requires failed-message provenance. |
| TUI customization | [`tui-customization.md`](tui-customization.md) | **NATIVE** | Themes, keybindings, `registerShortcut`, header/footer/widget/editor swap, `ui.custom()`. |
| Thinking status indicator | [`thinking-status.md`](thinking-status.md) | **BUILD** (done) | Default working ticker reports elapsed thinking time without replacing tool-wait messages. |

## Build priority

1. **`/goal`** + **`/run-plan`** — daily workflow; `/goal` is the headline feature and depends on
   the NATIVE context-injection + lifecycle contracts already documented.
2. **user-rules-loader**, **worktree-startup** — small, high-value, low-risk.
3. **permission-prompt-tool** + **approval-system** — needed to reuse the existing
   `claude-bash-hook-approval` MCP approval flow; build together (shared `core/permissions/`).

`loop` is already native and specced; remaining work is test coverage for unverified contract bullets.

## Dropped codex features (recorded, not specced)

These carried no portable value for Pi:

| Codex feature | Why dropped |
|---|---|
| Apply-patch → Claude `Write` translation | Pi has no `apply_patch`; native Write/Edit tools. |
| Unified-exec shell tool (legacy alias removal) | Codex upstream-divergence; Pi has its own shell tool. |
| Multi-agent v1 removal | Rebase housekeeping. (Multi-agent *v2* itself was deferred, not dropped.) |
| Skip `PWD` in shell env | Narrow codex parent-process fix. |
| Deploy + Osso branding (`-osso` suffix, LTO) | Codex fork-maintenance artifact. |
| Model prompt hygiene (GPT-5.4 apply_patch tuning, `*.snap.new`) | Codex/OpenAI + Rust-insta specifics. |
| Resume picker SQLite-first listing | Codex thread-store/rollout architecture; Pi uses JSONL sessions. |
| Session-end transcript parser | Pi exposes `SessionManager` API; no jq-in-shell-hook need. |
| App-server / MCP robustness fixes | Codex-specific bugs. |
| Upstream removals (~170k LOC) | Pure codex rebase deletion. |

## Deferred (not yet specced, may build later)

| Feature | Why deferred |
|---|---|
| None | Current deferred multi-agent work now has a tracked BUILD spec. |

## Conventions

See the `spec-format` skill for the 7-section template. A bullet is `- [x]` **only** when a
named test asserts it; otherwise `- [ ]`. NATIVE specs already carry a few `- [x]` where Pi tests
exist; their remaining `- [ ]` bullets are untested-but-present behaviors that need coverage.
