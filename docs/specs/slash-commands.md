# Slash-command dispatch

Module boundary: core subsystem.

Slash commands provide the user-facing dispatch layer for built-in commands, extension commands, skills, and prompt templates. The core contract lives in `packages/coding-agent/src/core/agent-session.ts`; interactive presentation and command completion are separate concerns. Runtime details belong in [`docs/wiki/systems/slash-commands.md`](../wiki/systems/slash-commands.md).

## What it must do

### Command resolution

- [x] Recognize extension commands before normal prompt processing and execute their handlers directly.
- [x] Expand matching skill commands and prompt templates before normal prompt processing.
- [ ] Recognize built-in command names consistently across interactive, SDK, and RPC entry points.
- [ ] Resolve the command name from the first non-whitespace token after `/`, leaving the remaining text as arguments.

### Unknown commands

- [x] Reject an unknown slash command passed to `AgentSession.prompt()` with `Unknown slash command: /name`.
- [x] Do not send a rejected unknown slash command to the provider or add it as a normal session user message.
- [x] Render unknown-command feedback inside the interactive TUI for idle and streaming Enter/Alt+Enter without an uncaught stack; preserve editor history and subsequent command/prompt usability.
- [ ] Reject unknown slash commands consistently when queued through `steer()` or `followUp()`.

### Account usage presentation

- [x] Show the full Codex `/usage` and `/usage reset` report immediately through a UI notification when busy, including during tool waits and for no-reset-credits results.
- [x] Preserve the busy-session custom report for the next turn without steering or interrupting active work; retain the existing idle custom-report display.
- [x] Keep Claude bridge `/usage` routing and reporting unchanged.

### Bundled `/exit`

- [x] Register `/exit` through the bundled first-party `exit-command` extension and call `ctx.shutdown()` directly, without a model prompt.
- [ ] Ignore `/exit` arguments, preserving the host command's behavior.
- [x] Discover `/exit` after starting a new session or `/reload` following a Pi update; no host-user extension installation is required. Allow disabling by inventory name `exit-command` through `disabledExtensions` in settings, then reload. See [extension settings](../../packages/coding-agent/docs/settings.md).

### Discovery and presentation

- [ ] Expose the currently available built-in, extension, skill, and prompt-template commands to completion UIs and RPC `get_commands` consumers.
- [ ] Keep command documentation synchronized with the runtime command registry.

## How it works

- Runtime dispatch: [`docs/wiki/systems/slash-commands.md`](../wiki/systems/slash-commands.md) (stub).
- Extension command registration: [`packages/coding-agent/docs/extensions.md`](../../packages/coding-agent/docs/extensions.md).
- Prompt-template discovery and expansion: [`packages/coding-agent/docs/prompt-templates.md`](../../packages/coding-agent/docs/prompt-templates.md).
- Skill command discovery: [`packages/coding-agent/docs/skills.md`](../../packages/coding-agent/docs/skills.md).

## Implementation inventory

- `packages/coding-agent/src/core/agent-session.ts` — validates slash-command names, executes extension commands, and expands skills and prompt templates.
- `packages/coding-agent/src/core/slash-commands.ts` — defines built-in slash-command metadata.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — handles interactive built-ins, submission routing, and command completion.
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts` — exposes prompt, queueing, and command-discovery RPC entry points.
- `packages/coding-agent/extensions/exit-command/src/index.ts` — registers `/exit` as a direct clean-shutdown command.
- `packages/coding-agent/extensions/codex-usage/src/index.ts` — reports Codex usage immediately while busy and retains the custom report for the next turn.

## Tests asserting this spec

- `packages/coding-agent/test/exit-command-extension.test.ts` — bundled `/exit` registration and clean-shutdown request through a real extension runner. Targeted test passes. Verified 2026-10-23: a disposable sandbox TUI exits cleanly through `/exit`; the active Clank conversation remains running.

- `packages/coding-agent/test/suite/agent-session-prompt.test.ts:223-261` — skill and prompt-template expansion.
- `packages/coding-agent/test/suite/agent-session-prompt.test.ts:280-296` — extension command handling and unknown-command rejection.
- `packages/coding-agent/test/suite/agent-session-prompt.test.ts:312-318` — handled slash-command history persistence.

- `packages/coding-agent/test/suite/regressions/interactive-unknown-slash-command.test.ts` — commit `e20b2a828` adds real-process PTY cases for idle/streaming Enter/Alt+Enter, visible feedback, no uncaught stack, no rejected provider/transcript input, editor recall, and subsequent built-in/template/plain-prompt usability. Source inspected; not executed in this docs task.

- `packages/coding-agent/test/codex-usage-routing.test.ts` — provider routing, busy read/reset/no-credit reports, idle reporting, and idle-state changes during a fetch.
- `packages/coding-agent/test/suite/regressions/interactive-usage-busy.test.ts` — real PTY Enter/Alt+Enter during held tools and provider requests, immediate full report, uninterrupted work, and next-turn persistence.

## Known gaps (current cycle)
- [ ] Add SDK/RPC coverage for unknown-command rejection.
- [ ] Decide whether queued `steer()` and `followUp()` messages should reject unknown slash commands or intentionally treat them as ordinary prompt text.

## Out of scope

- Command autocomplete matching, rendering, and keybindings.
- Extension command implementation details.
- Skill and prompt-template content semantics after expansion.
