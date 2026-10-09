# Slash-command dispatch

Contract: [Slash-command dispatch](../../specs/slash-commands.md).

## Dispatch and discovery

[`AgentSession.prompt()`](../../../packages/coding-agent/src/core/agent-session.ts) checks slash input before the turn-start lock when `expandPromptTemplates` is enabled (the default). Extension commands execute first, including while streaming. A handled command is recorded in control-DB prompt history, not appended as an ordinary user message. Handler exceptions become extension errors; dispatch still reports the command handled.

Unknown names throw `Unknown slash command: /name` before input hooks, provider processing, or user-message persistence. Known input then reaches the `input` hook, skill expansion, and [prompt-template expansion](../../../packages/coding-agent/src/core/prompt-templates.ts), before normal prompt or queue processing. `/skill:name args` reads the skill file and wraps its body with skill metadata and arguments.

[`InteractiveMode`](../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) separately handles built-ins and constructs completion from [`BUILTIN_SLASH_COMMANDS`](../../../packages/coding-agent/src/core/slash-commands.ts), templates, registered extension invocation names, and enabled skill commands. Extension-name collisions with interactive built-ins produce warnings. [`RPC get_commands`](../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts) returns extensions, templates, then skills, with `sourceInfo` provenance; it does not include interactive built-ins.

## Interactive rejection feedback

Commit `e20b2a828` catches streaming `prompt()` rejection for both Enter steering and Alt+Enter follow-up submission and renders `showError` inside the TUI. Idle submission uses existing error handling. The PTY regression covers all four idle/streaming key combinations, no uncaught stack or rejected provider/transcript input, editor recall, and subsequent built-in/template/plain-prompt usability. This does not change direct `steer()`/`followUp()` validation. Test source inspected, not executed here.

## Limits and unimplemented portions

- Built-in metadata makes a name *known* to `prompt()` but does not execute its interactive handler there. SDK/RPC built-in dispatch parity is unimplemented; use dedicated RPC operations where available.
- Parsing is not uniformly whitespace-based: preflight requires `/` at the start, name validation uses a whitespace regex, but extension/skill argument splitting uses the first literal space. Leading-whitespace and tab-separated dispatch are not normalized consistently.
- Direct `steer()` and `followUp()` reject extension commands and expand skills/templates, but do not perform unknown-name validation. Unknown queue rejection remains unimplemented.
- `expandPromptTemplates: false` bypasses this slash preflight. Interactive skill completion respects `enableSkillCommands`; RPC discovery enumerates loaded skills directly.

## Test locations

[`suite/agent-session-prompt.test.ts`](../../../packages/coding-agent/test/suite/agent-session-prompt.test.ts) checks skill/template expansion, extension dispatch without consuming a faux-provider response, unknown rejection with unchanged messages and pending response, and handled-command history deduplication. These are not proof of cross-entry-point parity.

API references: [extensions](../../../packages/coding-agent/docs/extensions.md), [prompt templates](../../../packages/coding-agent/docs/prompt-templates.md), [skills](../../../packages/coding-agent/docs/skills.md), [RPC](../../../packages/coding-agent/docs/rpc.md). Tests were inspected, not executed.
