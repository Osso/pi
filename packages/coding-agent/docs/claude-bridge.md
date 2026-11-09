# Claude bridge

Pi includes the first-party Claude bridge; no separate bridge installation is required. It uses the Claude Agent SDK for the `claude-bridge` provider and the optional AskClaude tool. Existing Claude authentication and bridge configuration remain in use. Pi skips a duplicate external bridge without changing user settings.

The bridge derives from pi-claude-bridge by Eli Dickinson, originally based on claude-agent-sdk-pi by Prateek Sunal. The original MIT license follows this guide.

## Provider

Use `/model` to select a Claude model, e.g. `claude-bridge/claude-fable-5-2`, `claude-bridge/claude-opus-5`, or `claude-bridge/claude-haiku-5-5`.

Behind the scenes, pi's tools are bridged to Claude Code but everything works like normal in pi. Bash commands get Claude Code's 120-second default timeout since pi's bash has none. Skills are forwarded to Claude Code's system prompt, and steering mid-turn reaches Claude at the next tool boundary.

**Web search:** Claude Code's native `WebSearch` runs inside the bridge using the current Claude account and model. The OpenAI-only Pi `web_search` tool is not forwarded to Claude. Search findings and source links appear in Claude's reply; native search calls are not separate Pi tool calls. Other native Claude tools remain disabled.

The model list comes from pi-ai's Anthropic catalog automatically — when pi-ai adds a new Claude model, it appears in `/model` after updating the package, no bridge update needed. The bridge also includes an explicit `claude-fable-5-2` entry while awaiting upstream metadata, without duplicating it if pi-ai adds it. Its bridge catalog metadata specifies a 200K context window with the bare model ID, 128K maximum output tokens, always-on adaptive thinking, text and image input, and zero subscription cost. The context window is an unmeasured bridge policy, not a verified inference limit. Dated snapshot ids (e.g. `claude-opus-4-5-20251101`) are not shown.

**1M Context:** Fable 5/5.1, Opus 5.5/5/4.8/4.7, and Sonnet 5.5/5 get 1M context. Opus 4.6 gets 1M only on a Max plan or with Extra Usage, and Sonnet 4.6 only with Extra Usage — set `provider.plan` and/or `provider.longContextExtraUsage` as described in [Configuration](#configuration).

## Account usage

With a `claude-bridge` model selected, `/usage` reports the currently selected account's subscription quota, not session token usage: 5-hour, 7-day, 7-day Opus, and 7-day Sonnet utilization with reset timestamps in UTC. Unavailable windows or reset times are labeled unavailable. With `provider.accountProfiles`, the report uses the bridge's current selection; otherwise it uses the current Claude credentials. Reporting does not switch accounts or advance quota rotation.

The source is Anthropic's OAuth usage API (`GET https://api.anthropic.com/api/oauth/usage`). Transient network failures, HTTP 429, and server errors receive bounded retries respecting `Retry-After`; an unresolved 429 reports the API status and supplied retry delay/deadline, not an inferred subscription reset.

For expired tokens, the existing Claude helper finishes and configured-profile persistence completes before usage rereads actual credentials, even if the child failed. A valid nonexpired token permits usage despite that failure. An unchanged expired token still reports an explicit sanitized refresh failure; invalid credentials and persistence errors are not swallowed. This does not change authentication, rotation, cost policy, or helper arguments.

Requires Pi's built-in `/usage` dispatcher emitting `claude-bridge:usage-request`; the bridge handles that event rather than registering a competing slash command. `/usage reset` and other arguments are unsupported for Claude: the bridge cannot reset subscription quota or consume reset credits.

## AskClaude Tool

Opt-in: set `askClaude.enabled` to `true` (see [Configuration](#configuration)). Available when using any non-claude-bridge provider. Pi's LLM can delegate tasks to Claude Code and wait for it to answer a question or perform a task. Examples of how to use:

- "Ask Claude to plan a fix"
- "If you get stuck, ask claude for help"
- "Ask claude to review the plan in @foo.md, implement it, then ask an isolated=true claude to review the implementation"
- "Ask claude to poke holes in this theory"

Delegated calls don't read global `CLAUDE.md` files or Claude Code's skill listing, and always get Claude Code's own system prompt.

### Parameters

- **`prompt`** — the question or task for Claude Code
- **`mode`** — `read` (default, read files and search/fetch on web), `none`, or `full` (read+write+bash, disable this mode with `allowFullMode: false` in config)
- **`model`** — `opus` (default), `sonnet`, `haiku`, or a full model ID
- **`thinking`** — effort level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`
- **`isolated`** — when `true`, Claude gets a clean session with no conversation history (default: `false`)

## Configuration

Config: `~/.pi/agent/claude-bridge.json` (global) or the project Pi config directory, usually `.pi/claude-bridge.json` (project; merged over global).

```json
{
  "askClaude": {
    "enabled": true,
    "allowFullMode": true,
    "defaultIsolated": false,
    "description": "Custom tool description override"
  },
  "provider": {
    "plan": "max",
    "longContextExtraUsage": false,
    "strictMcpConfig": true,
    "pathToClaudeCodeExecutable": "/home/you/.nix-profile/bin/claude"
  }
}
```

`askClaude`:
- `enabled` — register the AskClaude tool (default `false`). If it's unset, the startup notice below points this out once.
- `name` — override the tool's pi-side name (default `"AskClaude"`)
- `label` — override the TUI label (default `"Ask Claude Code"`)
- `description` — override the tool description. Default when `allowFullMode: true`: *"Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself."*
- `defaultMode` — `"read"` (default), `"none"`, or `"full"`
- `defaultIsolated` — start each call in a fresh session (default `false`)
- `allowFullMode` — allow `mode: "full"`; set `false` to lock it out
- `appendSkills` — forward pi's skills block into the system prompt (default `true`)

`provider`:
- `accountProfiles` — explicit ordered list of existing named credential profiles; enables provider rotation on subscription quota rejection or the exact organization-disabled error (see below). Unset by default.
- `plan` (default `"pro"`) — set to `"max"` if you have a Max (or Team Premium/Enterprise) Anthropic plan. This enables Opus with 1M context.
- `longContextExtraUsage` — set to `true` to enable 1M context models even if they cost money through Extra Usage on your plan. It enables Sonnet 4.6 with 1M on every plan and Opus 4.6 with 1M on Pro. Not needed for Opus 4.7 or 4.8.
- `forceTwoHundredK` — array of model ids to pin to 200K context (bare id, no `[1m]` suffix). Use if pi-ai declares a model at 1M but Claude Code won't serve it on your plan.
- `strictMcpConfig` — block MCP servers from `~/.claude.json` / `.mcp.json` (default `true`). Cloud MCP (Gmail/Drive via claude.ai OAuth) is always blocked.
- `autoMemoryEnabled` — enable Claude Code's auto-memory system (default `false`)
- `pathToClaudeCodeExecutable` — path to the `claude` binary. Useful if your OS/filesystem has the SDK's bundled musl/glibc binaries in a place where they can't run. For example, with Nix you can set the binary to e.g. `"/home/you/.nix-profile/bin/claude"`.


### Account profiles: subscription availability rotation

Opt in with existing saved profiles at `~/.claude/<name>.credentials.json`. Names must be unique and contain only letters, digits, underscores or hyphens, starting with a letter or digit. The bridge does not discover accounts or log them in. The selected account and dated quota rejections are shared by bridge processes through `~/.config/pi-claude-bridge/account-state/`, one `<pid>.json` per process merged on read. The bridge keeps the selected account while it is eligible and otherwise takes the next eligible profile in configured order, honoring newer denials. It reads subscription usage only after quota rejections leave no eligible account; healthy requests never query usage.

Example local server configuration in that server user's `~/.pi/agent/claude-bridge.json` (not a global default):

```json
{
  "provider": {
    "accountProfiles": ["alessio", "claude-agent", "gc"]
  }
}
```

Each provider subprocess gets its own profile's `CLAUDE_CONFIG_DIR` at `~/.config/pi-claude-bridge/profiles/<name>`. Usage reads and SDK preparation select the freshest file by modification time among the isolated credentials, named saved profile, and live credentials owned by that profile's active marker. Fresh-query preparation adopts a newer valid associated credential file in the same bridge process, without a manual Pi or bridge-client restart; a newer isolated SDK refresh remains usable before writeback. The newest file must be valid; malformed credentials never fall back to an older grant. This ordering supports the CLI's atomic global/named updates and SDK isolated refresh followed by named persistence, not arbitrary writers or preserved/backdated timestamps. Refreshes are written back after the query settles only if the saved profile has not changed. Observed named-profile drift instead triggers reconciliation through preparation and skips that persistence call's writeback. Repeated preparation that selects the isolated file retains its pending refresh baseline, so the refresh remains eligible for later persistence. This does not prove credential-cache reload inside an already-running native SDK child. Stop bridge queries before logging in or switching profiles: a late old-child write to the shared isolated file cannot be attributed to its originating query. External tools do not share a lock, and a noncooperating writer can still change the named file between the snapshot check and replacement; this is not concurrent or cross-process auth-switch safety. Other Claude configuration and project sessions are shared through symlinks. Existing real profile-local `skills`, `plugins`, and `cache` directories remain local when a real global counterpart appears later (for example after CLI login). Native `.claude.json` metadata also remains local when both global and profile entries are real regular files, whether profile-local SDK state preceded the global counterpart or native atomic rewriting replaced a shared link. Both entries retain their bytes and inodes without merging or deleting either. New-profile sharing remains unchanged; nonregular `.claude.json` pairs, foreign symlinks, and configured settings conflicts still fail explicitly. Missing profile entries still link to the global entries, so linked profiles observe later global edits, while retained local directories do not. Concurrent prepares validate any entry published by another writer before accepting it. For `policy-limits.json` and `remote-settings.json` only, byte-identical regular-file pairs are restored to shared symlinks on preparation; differing bytes remain untouched and fail explicitly. See [shared-profile config repair](docs/specs/shared-profile-config-repair.md). Foreign symlinks and regular-file collisions in other configuration entries still fail explicitly. The generated `policy-limits.json.stamp.json` and four signed-cache sidecars (`policy-limits.json.signature.json`, `policy-limits.json.signature-iat.json`, `remote-settings.json.signature.json`, `remote-settings.json.signature-iat.json`) are excluded from sharing: existing local entries remain untouched, and fresh profiles get no shared links for them. The actual policy and settings retain their existing sharing and conflict rules. See [profile signature metadata](docs/specs/profile-signature-metadata.md). This isolates credentials, not all Claude state; it does not switch `~/.claude/.credentials.json`, change the active-profile marker, or mutate the parent environment. Keep credential contents out of bridge configuration.

Selection advances on a failed query preceded by a rejected subscription-window event or a failed result with exact text `Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access`. The latter needs no `rate_limit_event`: it marks the account unavailable with an undated process-local denial and selects the next eligible profile. It invents no reset time; the existing undated-denial restart/reset and successful live-recheck boundaries below still apply. Credit-required long-context denials, ordinary auth failures, warnings, other ordinary errors and cancellation do not trigger this rotation; unconfigured calls remain unchanged. No API-key fallback or cost/auth change is introduced. For normal provider turns, the bridge prefixes the original error for Pi's default retry handling rather than retrying internally. The next provider call uses the selected eligible profile and continues from Pi's history, including recorded tool results, instead of replaying completed tools. Pi's retry settings and retry budget still apply.

Rejected profiles are skipped until their reported reset time, then become eligible on a later call. Recovery requires valid five-hour and seven-day utilization below 100%, plus any present, non-null window for the requested Opus/Sonnet model below 100%. Missing or invalid mandatory windows fail explicitly; absent or null model-specific windows do not block recovery. Valid capacity restores that profile even before its cached reset or after an undated rejection. Metered extra usage does not count as included capacity. Failed or malformed quota checks never restore eligibility; the exhaustion error includes sanitized recheck failures and HTTP retry timing. An unresolved HTTP 429 fails the recheck explicitly; it does not trigger an unverified inference attempt. Cached denials remain until actual acceptance settles without cancellation or an error; denials recorded at or after request start still win. Auth failures, malformed responses, and other usage failures do not permit such attempts. No SDK query is started after cancellation during rechecking.

Selection, dated rejections, and successful quota observations are shared through `account-state/`; each process writes only its own file. Observation time, not file rewrite time, lets recovered capacity supersede stale denials from other live processes. A denial recorded at or after a quota check began wins over its delayed successful response. Cancellation neither restores nor rejects a profile. Reset deadlines from before a successful recovery do not carry into later denials, regardless of peer-file order. Existing state files retain their denial evidence on read. Undated denials remain process-local until reset/restart or successful live rechecking. If all refreshed profiles are still unavailable, the error remains `Claude account profiles exhausted. No eligible account remains.` Regular provider quota and exact organization-disabled failures still use Pi's retry handling. Generic errors do not restore eligibility or record quota denials.

**Limits:** `accountProfiles` applies to normal provider turns and isolated one-off calls (compaction summaries, session titles), which retry on the next eligible account within the call after a quota rejection or the exact organization-disabled failure. AskClaude does not use this rotation path. Invalid or missing profile credentials fail the call rather than silently choosing another account.

**Startup notice:** the first session lists `provider.plan` and `askClaude.enabled` if unset, then records `startupNoticeShown` in the global config so it doesn't nag again.

**Extension providers and models.json:** pi's `modelOverrides` in `~/.pi/agent/models.json` do not currently apply to extension-registered providers (like claude-bridge). Overriding `contextWindow` or other fields requires changing the bridge model metadata — to pin a model to 200K, use `provider.forceTwoHundredK` instead.

## Session working directory

The bridge uses the calling Pi session's working directory for provider and AskClaude calls. Project configuration follows that directory.

## Mailbox shape diagnostics

Set `provider.shapeTrace: true` in Claude-bridge configuration and restart the affected runtime to record private, bounded SDK/bridge block types and correlated message/tool-call IDs. No text, reasoning or arguments are captured; no model probe or mailbox send is triggered. The private trace is written to `claude-bridge-shapes.jsonl` in the Pi agent directory, excludes content and arguments, and stops at a per-writer 4 MiB limit.. This is diagnostic instrumentation, not a fix for the unresolved missing-text report.

## Debugging

Configured-profile OAuth observations use a private normal-operation trace, independent of debug logging. The trace is written to `claude-bridge-auth.jsonl` in the Pi agent directory and excludes raw credentials.

Set `CLAUDE_BRIDGE_DEBUG=1` to enable debug output:

- **Bridge log** at `claude-bridge.log` in pi's agent dir (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`) — provider calls, session sync decisions, tool results, CC stderr. Override location with `CLAUDE_BRIDGE_DEBUG_PATH`.
- **Per-query CC CLI logs** at `cc-cli-logs/<timestamp>-<tag>-<seq>.log` in the same directory — the subprocess's own debug stream; tag is `provider` or `askclaude`. Shows CC's view of session loading, API requests, and tool calls.

When filing a bug about a session-resume failure (e.g. "No conversation found"), the most useful attachments are the `syncResult:` lines from the bridge log plus the matching `cc-cli-logs/` file for the failing query.

## Compatibility with other extensions

### Which injection routes reach Claude Code

The bridge forwards pi's structured parts — project context files, skills, custom prompt, appended instructions, and custom prompt sections (`systemPromptOptions.sections`) — and drops the rest. Measured against the request body (`diag/capture-proxy.mjs`):

| Route | Reaches Claude Code |
|---|---|
| `before_agent_start` -> `message` | Yes, as literal prompt text in the user turn |
| `context` editing the last user message | Yes, as literal prompt text |
| `--append-system-prompt` | Yes, with pi's appended instructions |
| `context_with_system` editing the system message | Yes when it wraps pi's prompt; the turn fails when it replaces one |
| `before_agent_start` -> `systemPromptOptions.sections` | Yes, one `<name>` block per section |
| `before_agent_start` -> `systemPrompt` | No, dropped |

Two traps. Returning `systemPrompt` from `before_agent_start` makes pi replace the whole system prompt, discarding any `context_with_system` edit in the same run — only one reaches the request. And system-prompt edits work by *wrapping*: replacing pi's prompt leaves the bridge with nothing to match, so it refuses the turn rather than send Claude Code a request missing your context files, skills and custom instructions. The error names the closest known prompt and where it diverged.

To add instructions, use `message`, `context`, or a system-message edit that keeps pi's prompt intact.

### Hooks written for Claude Code

`~/.claude/settings.json` hooks fire inside bridge turns, so a hook injecting Claude-specific guidance duplicates what pi's extensions already provide. pi sets `PI_CODING_AGENT=true` for child processes, including the Claude Code child; a hook can skip itself on that:

```sh
[ -n "$PI_CODING_AGENT" ] && exit 0
```

Hooks do not fire on the compact-summary side query.

### System prompt rejections

Other extensions can change the system prompt. When the result still contains pi's built-in system prompt text, or the two documentation paths that Anthropic looks for (`docs/custom-provider.md` in the same prompt with `docs/packages.md`), the bridge stops the turn instead of sending it, since Anthropic may otherwise bill these requests as Extra Usage. Fix the source extension before retrying; `CLAUDE_BRIDGE_DEBUG=1` writes the full prompt to the bridge log when this happens.

### Using claude bridge with @gotgenes/pi-subagents

Requires the following in `~/.pi/agent/subagents.json`:

```json
{"promptInheritance": {"claude-bridge": "portable"}}
```

## Known issues

**A session rebuild re-sends the whole conversation.** The bridge rewrites Claude Code's session from pi's history whenever the two diverge — after an abort, `/compact`, tree navigation, an API error, or on returning to a session — and the next request usually misses the prompt cache for everything past the system prompt. Abort-heavy sessions cost noticeably more.

**Files Claude Code edits are not carried across a rebuild.** The edit itself survives in the history as a tool call and result — what's lost is the post-edit file snapshot. `@file` expansions *are* carried.

**System prompt changes mid-session may not reach the model.** The bridge keeps Claude Code's default prompt recording: project context (AGENTS.md/CLAUDE.md), skills, and extension-written instructions are captured on the first request and reused on resume. This keeps the cached prefix stable, but later changes may not take effect until a rebuild or compaction. Start a new session if updated instructions must take effect immediately.

**Exported Anthropic environment variables override the Claude Code child (issue #107).** An exported `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` redirects Claude Code to that gateway and every turn fails with its auth error. Unset them for the pi process.

## Original license

```text
MIT License

Copyright (c) 2026 Eli Dickinson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
