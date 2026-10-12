# Slash-command dispatch

Contract: [Slash-command dispatch](../../specs/slash-commands.md).

## Dispatch and discovery

[`AgentSession.prompt()`](../../../packages/coding-agent/src/core/agent-session.ts) checks slash input before the turn-start lock when `expandPromptTemplates` is enabled (the default). Extension commands execute first, including while streaming. A handled command is recorded in control-DB prompt history, not appended as an ordinary user message. Handler exceptions become extension errors; dispatch still reports the command handled.

Unknown names throw `Unknown slash command: /name` before input hooks, provider processing, or user-message persistence. Known input then reaches the `input` hook, skill expansion, and [prompt-template expansion](../../../packages/coding-agent/src/core/prompt-templates.ts), before normal prompt or queue processing. `/skill:name args` reads the skill file and wraps its body with skill metadata and arguments.

[`InteractiveMode`](../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) separately handles built-ins and constructs completion from [`BUILTIN_SLASH_COMMANDS`](../../../packages/coding-agent/src/core/slash-commands.ts), templates, registered extension invocation names, and enabled skill commands. Extension-name collisions with interactive built-ins produce warnings. [`RPC get_commands`](../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts) returns extensions, templates, then skills, with `sourceInfo` provenance; it does not include interactive built-ins.

## Interactive rejection feedback

Commit `e20b2a828` catches streaming `prompt()` rejection for both Enter steering and Alt+Enter follow-up submission and renders `showError` inside the TUI. Idle submission uses existing error handling. The PTY regression covers all four idle/streaming key combinations, no uncaught stack or rejected provider/transcript input, editor recall, and subsequent built-in/template/plain-prompt usability. This does not change direct `steer()`/`followUp()` validation. Test source inspected, not executed here.

## Codex `/usage` busy reporting

The report used ordinary custom-message delivery, which defaults to steering while streaming; display therefore depended on the agent consuming its queue rather than immediate UI presentation during tool waits. `sendCodexUsageReport()` now checks `ctx.isIdle()` after the fetch: busy sessions receive the full report through `ctx.ui.notify()` and retain the custom message with `deliverAs: "nextTurn"`, without steering active work. Idle sessions retain ordinary custom-message display. Read, reset, and no-reset-credit results share this path; Claude bridge routing is unchanged. Contract: [account usage presentation](../../specs/slash-commands.md#account-usage-presentation).

### Deployment evidence — October 12, 2026

Source `018a2f700`: source verification passed 29 tests, `npm run check`, and readability audit. `deploy.sh` exited 0; logs `/tmp/pi-usage-deploy.stdout` and `/tmp/pi-usage-deploy.stderr` record version `0.80.3` and check/build output. Installed SHA-256: `6c1f69a1b70d8fb82a002049821c017781222f2f86adb8500d1472ee01a25c95`.

Bounded local rollout covered four eligible installed-`pi` sessions, initially all on `e8df4db862f9b40380b4c7c5f111dce692222d4a8f8a4e256c7ac10bec2a2629`. Main restarted three by exact session ID through control restart and itself through `restart_self`. Final health inventory reported all four `running`/`checkStatus=ok`/eligible; `/tmp/pi-usage-runtime-before.json` and `/tmp/pi-usage-runtime-after.json` show every `/proc` executable matching the deployed hash with identical PID/start ticks. No `pi-dev` or remote `agent-server` coverage.

Independent installed-binary verification passed `--version`, `--help`, and four real-PTY cases: pending tool and held provider, each with Enter/Alt+Enter. The full report appeared before work was released, without an extra provider request or abort, and reached the subsequent user turn and persisted transcript. The installed built-in command was exercised with isolated fake credentials, a faux provider, and a fetch mock that rejects unexpected URLs; real upstream API/auth behavior was not tested. Report: `/tmp/pi-usage-deployment-verification.md`; packet and logs: `/tmp/pi-usage-deploy-smoke/`.

## Limits and unimplemented portions

- Built-in metadata makes a name *known* to `prompt()` but does not execute its interactive handler there. SDK/RPC built-in dispatch parity is unimplemented; use dedicated RPC operations where available.
- Parsing is not uniformly whitespace-based: preflight requires `/` at the start, name validation uses a whitespace regex, but extension/skill argument splitting uses the first literal space. Leading-whitespace and tab-separated dispatch are not normalized consistently.
- Direct `steer()` and `followUp()` reject extension commands and expand skills/templates, but do not perform unknown-name validation. Unknown queue rejection remains unimplemented.
- `expandPromptTemplates: false` bypasses this slash preflight. Interactive skill completion respects `enableSkillCommands`; RPC discovery enumerates loaded skills directly.

## Test locations

[`suite/agent-session-prompt.test.ts`](../../../packages/coding-agent/test/suite/agent-session-prompt.test.ts) checks skill/template expansion, extension dispatch without consuming a faux-provider response, unknown rejection with unchanged messages and pending response, and handled-command history deduplication. These are not proof of cross-entry-point parity.

API references: [extensions](../../../packages/coding-agent/docs/extensions.md), [prompt templates](../../../packages/coding-agent/docs/prompt-templates.md), [skills](../../../packages/coding-agent/docs/skills.md), [RPC](../../../packages/coding-agent/docs/rpc.md). Tests were inspected, not executed.
