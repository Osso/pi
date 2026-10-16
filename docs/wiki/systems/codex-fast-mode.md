# Codex fast mode

Contract: [Codex fast mode](../../specs/codex-fast-mode.md).

## Authority and requests

[`codex-fast/src/index.ts`](../../../packages/coding-agent/extensions/codex-fast/src/index.ts) registers `/fast`. Bare invocation toggles priority/off; `on`, `ultra`, and `off` select priority, ultrafast, and disabled respectively. Enabling requires `openai-codex`, `openai-codex-gc`, or `openai-codex-team`; this check is implemented despite its unchecked spec item. Invalid arguments or child-runtime commands warn without changing authority.

[`main.ts`](../../../packages/coding-agent/src/main.ts) constructs a mutable `FastModeAuthority` shared through first-party extension factories. Explicit child identity (`multiAgentAgentId` or `multiAgentRequiresAgentId`) prevents command mutation; historical subagent transcript provenance does not.

Every `before_provider_request` reads current authority. Supported Codex object payloads are shallow-copied with `service_tier: "priority"` or `"ultrafast"`. Unsupported providers and disabled mode leave payloads unchanged. Non-object payloads warn for that request without clearing the tier. Footer behavior is independent of command targeting and request mutation; selecting a child does not change either.

## Displayed-session footer

Footer key `codex-fast` registers a pure `ctx.ui.setStatus` callback. [`FooterDataProvider.getExtensionStatuses()`](../../../packages/coding-agent/src/core/footer-data-provider.ts) resolves it on each read with the current `FooterSessionOverride`, so switching views does not require a main-model change event.

The callback reads shared authority and checks the displayed model's provider. A supported Codex child shows `fast` for priority or `fast ultra` for ultrafast even when the main model is Opus. An unsupported or unknown selected-child model returns `undefined`, hiding the status without substituting the main model or clearing the selected tier. With no override (including after returning to main), it checks the main model instead. Disabled authority hides the status in every view.

See the [extension status API](../../../packages/coding-agent/docs/extensions.md#widgets-status-and-footer) for callback purity and clearing semantics.

## Persistence and limits

Accepted commands append non-context `codex-fast-mode` custom entries with `{ serviceTier }`; `null` means explicit off. Main startup scans the loaded branch backwards for the latest valid entry, then uses merged `defaultCodexFastMode` only if no valid entry exists. Children do not restore over shared authority. Defaults are not appended merely by opening a session.

[`agent-session-runtime.ts`](../../../packages/coding-agent/src/core/agent-session-runtime.ts) flushes pending entries before restart handoff. Restoration depends on entries present in the loaded branch; this extension does not checkpoint entries omitted by compacted-session loading. It does not confirm provider acceptance or pricing of a requested tier.

## Evidence

Tests inspected, not run: [extension tests](../../../packages/coding-agent/test/codex-fast-extension.test.ts) assert commands, provider checks, payloads, footer, defaults, persistence and child authority; [restart regression](../../../packages/coding-agent/test/suite/regressions/codex-fast-restart.test.ts) covers pre-response persistence and live-child restart; [runtime tests](../../../packages/coding-agent/test/suite/agent-session-runtime.test.ts) cover entry flushing; [inventory tests](../../../packages/coding-agent/test/cli-runtime-inventory.test.ts) cover first-party loading.
