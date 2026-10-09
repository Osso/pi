# Pi implementation wiki

This wiki explains how this fork's systems work. [Feature specs](../specs/README.md) define behavior contracts; each system page links to its spec and implementation evidence. A page's presence does not mean every requirement is implemented or tested. Test-file references identify coverage to inspect, not a claim that tests ran for this documentation update.

For installation, CLI usage, and extension APIs, start with the [coding-agent manual](../../packages/coding-agent/README.md) and [API documentation](../../packages/coding-agent/docs/). Dated experiments and deployment evidence describe their recorded revision, not the current installed runtime.

## Goals, agents, and resident services

| System | Page |
|---|---|
| Persistent objectives and continuation | [Goal system](systems/goal-system.md) |
| Agent construction, messaging, and projections | [Multi-agent](systems/multi-agent.md) |
| Durable lifecycle and ownership | [Agent lifecycle](systems/agent-lifecycle.md) |
| Saved-session attachment | [Resume session as agent](systems/resume-session-as-agent.md) |
| Policy and bounded advice | [Supervisor service](systems/supervisor-service.md) |
| Retained, disabled observer | [Architect service](systems/architect-service.md) |
| Real-process test infrastructure | [Headless Pi fixture](systems/headless-pi-test-fixture.md) |
| Effort and delegation policy | [Reasoning effort and delegation](systems/reasoning-effort-delegation.md) |

## Sessions and runtime state

| System | Page |
|---|---|
| SQLite control state | [Session control database](systems/session-control-db.md) |
| Session lookup at startup | [CLI session lookup](systems/session-cli-lookup.md) |
| Main-session replacement | [Resume session tool](systems/resume-session-tool.md) |
| Persistent cwd changes | [Change working directory](systems/change-working-directory-tool.md) |
| Runtime inventory and delivery eligibility | [Session directory tools](systems/session-directory-tools.md) |
| Archive, restore, and deletion | [Session archive](systems/session-archive.md) |
| Automatic session titles | [Session autonaming](systems/session-autoname.md) |
| Resume-picker matching | [Session selector search](systems/session-selector-search.md) |
| Active-branch history retrieval | [Current session history search](systems/current-session-history-search.md) |
| Persistence-only output cap | [Session tool output](systems/session-tool-output.md) |
| Global coordination log | [Shared channel](systems/shared-channel.md) |
| Runtime replacement | [Self-restart](systems/self-restart.md) |
| Startup directory isolation | [Worktree startup](systems/worktree-startup-option.md) |

## Tools, approvals, and execution

| System | Page |
|---|---|
| Policy and reviewer orchestration | [Approval system](systems/approval-system.md) |
| Delegated approval interaction | [Permission prompt tool](systems/permission-prompt-tool.md) |
| Worker filesystem isolation | [Bubblewrap sandbox](systems/bwrap-sandbox.md) |
| Session tool allowlist | [Safe mode](systems/safe-mode.md) |
| Structured user decisions | [Ask questions](systems/ask-questions-tool.md) |
| Hidden credential provisioning | [Ask secret](systems/ask-secret-tool.md) |
| Explicit turn termination | [End-turn tool](systems/end-turn-tool.md) |
| Repeated text-turn detection | [Duplicate-turn guard](systems/duplicate-turn-guard.md) |
| Durable long-running tool jobs | [Tool backgrounding](systems/tool-backgrounding.md) |
| Python console events | [Pyrun console streaming](systems/pyrun-console-streaming.md) |
| Recurring session prompts | [Loop tool](systems/loop-tool.md) |
| Hosted search | [Web search](systems/web-search-tool.md) |
| Hosted image output | [Codex image generation](systems/codex-image-generation.md) |
| Tool and extension visibility | [Runtime inventory](systems/runtime-inventory.md) |
| Executable resolution | [System tool lookup](systems/system-tool-lookup.md) |
| Privileged live-process inspection | [Debug REPL](systems/debug-repl.md) |

## Context, commands, and extension hooks

| System | Page |
|---|---|
| Paths and configuration roots | [Configuration location](systems/config-location.md) |
| Instruction files and project memory | [Project context files](systems/project-context-files.md) |
| Shared and project rules | [User rules loader](systems/user-rules-loader.md) |
| Historical prompt enrichment | [Claude memory enrichment](systems/claude-memory-enrichment.md) |
| Prompt and provider context hooks | [Prompt context hooks](systems/prompt-context-hooks.md) |
| Tool-call input mutation | [Pre-tool-use rewrites](systems/pre-tool-use-rewrites.md) |
| Session event and replacement boundaries | [Session lifecycle hooks](systems/session-lifecycle-hooks.md) |
| Provider request instrumentation | [Model-request events](systems/model-request-extension-events.md) |
| Slash-command resolution | [Slash commands](systems/slash-commands.md) |
| Plan execution prompt | [Run-plan command](systems/run-plan-command.md) |
| Specification audit prompt | [Spec validation](systems/spec-validation.md) |
| Themes, bindings, and custom components | [TUI customization](systems/tui-customization.md) |
| Working-row and phase timing | [Thinking status](systems/thinking-status.md) |

## Models, transport, and compaction

| System | Page |
|---|---|
| Cached OpenRouter metadata | [Model catalog cache](systems/model-catalog-cache.md) |
| Scoped model selection | [Model cycling](systems/model-cycling.md) |
| Codex request transport selection | [OpenAI Codex transport](systems/openai-codex-transport.md) |
| Priority processing | [Codex fast mode](systems/codex-fast-mode.md) |
| Paired-provider quota handling | [Codex quota fallback](systems/codex-quota-fallback.md) |
| Native replacement history, opt-in extension | [OpenAI remote compaction](systems/openai-remote-compaction.md) |
| Length-truncated turn continuation | [Compaction length retry](systems/compaction-length-retry.md) |
| Idle prompt-cache scheduling | [Idle compaction](systems/idle-compaction.md) |
| Cache-only speculative preparation | [Background compaction cache](systems/speculative-background-compaction-cache.md) |

## Recorded experiments

[Native Ultra spawn-contract experiment](systems/native-ultra-spawn-contract-experiment.md) records a bounded schema comparison. Its historical tool names and outcomes are not current API guidance; use [multi-agent](systems/multi-agent.md) for that.
