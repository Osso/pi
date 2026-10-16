# Consolidated usage view

Module boundary: first-party extension (`packages/coding-agent/extensions/codex-usage/src/index.ts`).

`/usage all` displays Codex provider and Claude account usage together, regardless of the current
model. It is a report, not an account-switching or quota-fallback operation. See the
[usage guide](../../packages/coding-agent/docs/usage.md#slash-commands) for command behavior.

## What it must do

### Command and delivery

- [x] Accept `/usage all` regardless of the current model and include `all` in command completions.
- [x] Leave `/usage` and `/usage reset` behavior unchanged, except that a Codex window without
      `used_percent` is omitted instead of shown as 0% (shared window mapping).
- [x] Read Codex and Claude usage concurrently and publish one custom message of type `usage-all`;
      while a turn is running, show it as a notification and deliver the message on the next turn.

### Codex providers

- [x] Include every provider keyed by `CODEX_FALLBACK_PROVIDERS`: `openai-codex`,
      `openai-codex-gc`, and `openai-codex-team`.
- [x] Show logged-in providers' identity (email and plan), 5-hour usage (300-minute window), and
      weekly usage (10080-minute window), including used percentages and UTC reset times.
- [x] Mark the active Codex provider, show unauthenticated providers as `not logged in`, and
      preserve per-provider failures as error rows without losing other providers' results.
- [x] Show missing windows or missing `used_percent` as unavailable, never as 0%. Codex currently
      returns only a weekly window for some plans; the 5-hour column is then unavailable.
- [x] Obtain each provider's token through normal auth storage; an expired OAuth token is refreshed
      and persisted exactly as on any other request for that provider.
- [x] Keep provider identities distinct in the report without claiming separate quotas: the same
      email may authenticate multiple providers, and provider IDs alone do not prove quota independence.

### Claude accounts

- [x] Request Claude accounts through `claude-bridge:usage-all-request` with payload
      `{ accounts?: Promise<ClaudeAccountUsage[]> }`.
- [x] Accept successful entries shaped as `{ account, selected, fiveHour, weekly }` and failed entries
      shaped as `{ account, selected, error }`; display account usage or its error and mark the selected
      account with `*`.
- [x] Show `Claude bridge not loaded` when no listener supplies the accounts promise, show an error
      line when the promise rejects, and show error rows for malformed entries.

## How it works

- [Provider authentication and Codex account setup](../../packages/coding-agent/docs/providers.md#openai-codex)

## Implementation inventory

- `packages/coding-agent/extensions/codex-usage/src/index.ts` — registers the command, collects
  provider/account usage, and renders the consolidated report.
- `packages/coding-agent/src/core/codex-quota-fallback.ts` — defines the Codex provider keys used
  to enumerate report rows; fallback behavior is unchanged.

## Tests asserting this spec

- `packages/coding-agent/test/codex-usage-extension.test.ts` — consolidated report behavior.
- `packages/coding-agent/test/codex-usage-routing.test.ts` — command routing, mixed-provider rows,
  weekly-only Codex payload, and existing usage behavior.
- `packages/coding-agent/test/suite/regressions/interactive-usage-all.test.ts` — real TUI process,
  `/usage all` while a turn is running.

## Known gaps (current cycle)

- [ ] Claude accounts holding inference-only `claude setup-token` tokens report HTTP 403; the usage
      endpoint requires the `user:profile` scope granted by a full `claude auth login`.

## Out of scope

- Routing, quota-fallback, or authentication policy changes; this feature only reports existing usage.
- Switching providers or Claude accounts, or changing the selected model; selection is displayed only.
- Inferring quota independence from provider IDs or deduplicating providers by email; neither establishes
  whether upstream quotas are shared.
