# `--permission-prompt-tool` (MCP-delegated approval)

Module boundary: core permission-dispatch integration, not a first-party extension module. It routes through existing tool-call approval plumbing.

Lets Pi delegate "approve this tool call?" decisions to an external MCP tool,
matching Claude Code's `--permission-prompt-tool` wire protocol so a single MCP
server (e.g. `claude-bash-hook-approval`) works with both harnesses. Source will
live in `packages/coding-agent/src/core/permissions/mcp-permission-prompt.ts`,
wired into Pi's existing `tool_call` hook path in
`packages/coding-agent/src/core/agent-session.ts`. Implementation details belong
in `docs/wiki/systems/permission-prompt-tool.md` (stub — not yet written).

## What it must do

### CLI / config surface

- [x] Accept `--permission-prompt-tool <mcp__server__tool>` on the `pi` CLI.
- [x] Accept `permissionPromptTool` in `.pi/settings.json` (project) and
  `~/.pi/agent/settings.json` (global).
- [x] Thread the configured tool name through session creation options so it is
  part of the per-session snapshot.

### Approval loop

- [x] When a `tool_call` event fires AND a permission-prompt tool is configured,
  call the external MCP tool first and honor its decision before falling through to
  the native `ui.confirm` prompt.
- [x] No tool configured → fall through to the existing native `tool_call`/
  `ui.confirm` interactive path.
- [x] Invalid tool name (not in `mcp__server__tool` shape) → fall through to
  native interactive path.
- [x] MCP tool errors, timeouts, or connection failures → fall through to native
  interactive path.
- [x] Malformed tool response (missing `behavior`, non-JSON, unexpected shape) →
  fall through to native interactive path.

### Decision shapes

- [x] `{"behavior":"allow"}` → tool call runs without further prompting.
- [x] `{"behavior":"allow","updatedInput":{...}}` → tool call runs with its
  input replaced by `updatedInput`; mutate `event.input` in place (matching the
  existing `ToolCallEvent` mutation contract).
- [x] `{"behavior":"deny","message":"..."}` → tool call is blocked; return
  `{block: true, reason: message}` from the `tool_call` handler.
- [x] `updatedPermissions:[{type:"addRules",destination,behavior,rules:[...]}]`
  is honored when present alongside the decision.

### Rule persistence

- [x] `destination:"session"` + `behavior:"allow"` rule caches approval in memory
  and suppresses future prompts for the matching `{toolName, ruleContent}` within
  the same Pi session.
- [x] `destination:"userSettings"` writes the rule to `~/.pi/agent/settings.json`.
- [x] `destination:"projectSettings"` writes the rule to `.pi/settings.json`.
- [x] `destination:"localSettings"` writes to `.pi/settings.local.json`.
- [x] JSON writes preserve existing file formatting using surgical key insertion,
  not full re-serialization.
- [x] Non-session rules do not suppress in-memory follow-up prompts unless they
  also match the persisted-rules check on next evaluation.
- [x] Persisted allow rules suppress future prompts across sessions after settings reload.

## How it works

- `docs/wiki/systems/permission-prompt-tool.md` (stub — not yet written).
- `docs/specs/approval-system.md` — the policy layer this tool plugs into.

## Wire compatibility findings

Verified against `/syncthing/Sync/Projects/claude/claude-bash-hook/src/bin/approval_prompt.rs`
on 2026-06-21.

- Input schema is compatible with the planned Pi bridge: the MCP tool accepts
  `{ tool_name, input, tool_use_id?, permission_suggestions?, blocked_path?, cwd? }`.
- Output is a JSON string containing Claude permission-prompt decisions, not a
  structured MCP object. Pi must parse the tool result text as JSON before dispatch.
- `SAFE` maps to `{"behavior":"allow","updatedInput":<original input>}` and may include
  `updatedPermissions` with a session `addRules` allow rule.
- `UNSURE` and `UNSAFE` use MCP elicitation when supported; transport errors, unsupported
  elicitation, invalid elicitation content, `Decline`, and `Cancel` all fall back to allow-once.
- **Compatibility gap:** elicitation choice `deny` currently returns allow-once in
  `handle_unsure()` (`UserChoice::Deny => allow_once()`), so the existing
  `claude-bash-hook-approval` server does **not** provide a 1:1 `deny` mapping for Pi yet.
  This must be fixed in the hook server or explicitly accepted as unsafe before Pi can rely on it
  for denial decisions.

Compatibility decision for Pi:

- Pi-side response parsing and dispatch must still implement the full Claude decision contract,
  including `{"behavior":"deny","message":"..."}`.
- Tests for Pi's parser/dispatcher must use a stub MCP tool that returns real `allow`,
  `allow`+`updatedInput`, and `deny` responses, so Pi does not inherit the current hook-server bug.
- Real `mcp__claude-bash-hook-approval__approval_prompt` integration remains blocked until the
  hook server maps elicitation `deny` to `{"behavior":"deny","message":"..."}`. Until then,
  configuring that specific tool must either be rejected with a clear diagnostic or treated as
  experimental and not counted as satisfying deny-path acceptance.

Evidence:

- `approval_prompt.rs:41-61` — `ApprovalInput` schema.
- `approval_prompt.rs:81-93` — serialized decision enum with `behavior`, `updatedInput`,
  `updatedPermissions`, and deny `message`.
- `approval_prompt.rs:754-838` — elicitation handling and current deny-to-allow-once behavior.
- `approval_prompt.rs:841-862` — SAFE allow decision with session-scoped remembered rule.
- `cargo test --bin claude-bash-hook-approval` — 62 tests passed.

## Implementation inventory

- `packages/coding-agent/src/cli/args.ts` — adds `permissionPromptTool?: string`
  to the `Args` interface and parses `--permission-prompt-tool` flag.
- `packages/coding-agent/src/main.ts` — thread the parsed flag into session
  creation options.
- `packages/coding-agent/src/core/permissions/` — new directory. (started)
- `packages/coding-agent/src/core/permissions/mcp-permission-prompt.ts` — main
  module: builds the MCP tool call input, parses and validates the response,
  and implements the decision/fallback dispatcher. (partial; session-rule cache
  and destination-aware JSON writers still planned)
- `packages/coding-agent/src/core/permissions/rule-store.ts` — in-memory session
  rule cache and persistent-rule write helpers.
- `packages/coding-agent/src/core/agent-session.ts` — wire
  `mcp-permission-prompt` into `_installAgentToolHooks` so it runs before
  `ui.confirm`.

## Tests asserting this spec

- `packages/coding-agent/test/mcp-permission-prompt.test.ts` — parser and dispatcher
  coverage for allow, allow+updatedInput, deny, malformed response fallback,
  invalid tool-name fallback, MCP error fallback, `updatedPermissions`, session
  allow-rule cache suppression, and non-session follow-up prompting.
- `packages/coding-agent/test/permission-rule-store.test.ts` — in-memory exact rule
  matching, persisted rule loading, user/project/local settings writes, and
  formatting-preserving write insertion.
- `packages/coding-agent/test/args.test.ts` — CLI flag parsing and missing-value
  diagnostics.
- `packages/coding-agent/test/settings-manager.test.ts` — settings merge for
  `permissionPromptTool` with project overriding global.
- `packages/coding-agent/test/suite/agent-session-model-extension.test.ts` —
  session-level stub MCP permission prompt dispatch for updated input, deny
  decisions, and persisted-rule reload suppression.

## Known gaps (current cycle)

- [x] **Verify `claude-bash-hook-approval` wire compatibility first** — this whole
  bridge exists to reuse the existing `mcp__claude-bash-hook-approval__approval_prompt`
  server (driver for the feature). Before building anything else, contract-test the
  real wire shapes against each other: Claude Code's permission-prompt-tool returns
  `allow` / `allow`+`updatedInput` / `deny`+message, while `approval_prompt.rs` decides
  via MCP elicitation (SAFE→auto-allow, UNSURE/UNSAFE→prompt with the codex reason as
  hint). Confirm the server's response maps 1:1 onto the three decision shapes — and
  that elicitation round-trips through Pi's MCP client — rather than assuming it does
  because it was written as a Claude permission-prompt-tool.
- [x] Fix or account for the hook-server compatibility gap where elicitation `deny`
  currently returns allow-once instead of `{"behavior":"deny","message":"..."}`.
- [x] Define MCP tool call input schema (tool name, tool input, session context).
- [x] Implement response parser and decision dispatcher.
- [x] Implement session-rule cache and persistent-rule writers.
- [x] Wire into `agent-session.ts` `beforeToolCall` hook.
- [x] Add `--permission-prompt-tool` flag to `args.ts` and thread through `main.ts`.
- [x] Write unit tests for each decision shape and fallback path.
- [x] Write stub MCP-style integration tests exercising decision and persistence
  combinations through the `tool_call` path.

## Out of scope

- Reimplementing Claude Code's full rule-matching syntax; exact `ruleContent`
  equality matching is sufficient for now.
- A Pi-native TUI approval modal; the existing `ui.confirm` interactive path is
  the fallback when no MCP tool is configured.
- Applying `--permission-prompt-tool` to MCP tool calls registered by
  extensions; the initial scope covers built-in Pi tools only.
