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
- [ ] Reject unknown slash commands consistently when queued through `steer()` or `followUp()`.

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

## Tests asserting this spec

- `packages/coding-agent/test/suite/agent-session-prompt.test.ts:223-261` — skill and prompt-template expansion.
- `packages/coding-agent/test/suite/agent-session-prompt.test.ts:280-296` — extension command handling and unknown-command rejection.
- `packages/coding-agent/test/suite/agent-session-prompt.test.ts:312-318` — handled slash-command history persistence.

## Known gaps (current cycle)

- [ ] Add direct provider-call assertions for the unknown-command regression.
- [ ] Add SDK/RPC coverage for unknown-command rejection.
- [ ] Decide whether queued `steer()` and `followUp()` messages should reject unknown slash commands or intentionally treat them as ordinary prompt text.

## Out of scope

- Command autocomplete matching, rendering, and keybindings.
- Extension command implementation details.
- Skill and prompt-template content semantics after expansion.
