# Consolidated usage view

Module boundary: first-party extension (`packages/coding-agent/extensions/codex-usage/src/index.ts`).

`/usage all` displays Codex provider and Claude account usage together, regardless of the current
model. It is a read-only report, not an account-switching or quota-fallback operation. See the
[usage guide](../../packages/coding-agent/docs/usage.md#slash-commands) for command behavior and the
[architecture reference](../wiki/systems/consolidated-usage-view.md) for implementation details.

## What it must do

### Command and delivery

- [ ] Accept `/usage all` regardless of the current model and include `all` in command completions.
- [ ] Leave `/usage` and `/usage reset` behavior unchanged.
- [ ] Read Codex and Claude usage concurrently and publish one custom message of type `usage-all`.

### Codex providers

- [ ] Include every provider keyed by `CODEX_FALLBACK_PROVIDERS`: `openai-codex`,
      `openai-codex-gc`, and `openai-codex-team`.
- [ ] Show logged-in providers' identity (email and plan), 5-hour usage (300-minute window), and
      weekly usage (10080-minute window), including used percentages and UTC reset times.
- [ ] Mark the active Codex provider, show unauthenticated providers as `not logged in`, and
      preserve per-provider failures as error rows without losing other providers' results.
- [ ] Show missing windows or missing `used_percent` as unavailable, never as 0%.
- [ ] Keep provider identities distinct in the report without claiming separate quotas: the same
      email may authenticate multiple providers, and provider IDs alone do not prove quota independence.

### Claude accounts

- [ ] Request Claude accounts through `claude-bridge:usage-all-request` with payload
      `{ accounts?: Promise<ClaudeAccountUsage[]> }`.
- [ ] Accept successful entries shaped as `{ account, selected, fiveHour, weekly }` and failed entries
      shaped as `{ account, selected, error }`; display account usage or its error and mark the selected
      account with `*`.
- [ ] Show `Claude bridge not loaded` when no listener supplies the accounts promise, show an error
      line when the promise rejects, and show error rows for malformed entries.

## How it works

- [Consolidated usage architecture](../wiki/systems/consolidated-usage-view.md) (documentation stub)
- [Provider authentication and Codex account setup](../../packages/coding-agent/docs/providers.md#openai-codex)

## Implementation inventory

- `packages/coding-agent/extensions/codex-usage/src/index.ts` — registers the command, collects
  provider/account usage, and renders the consolidated report.
- `packages/coding-agent/src/core/codex-quota-fallback.ts` — defines the Codex provider keys used
  to enumerate report rows; fallback behavior is unchanged.

## Tests asserting this spec

- `packages/coding-agent/test/codex-usage-extension.test.ts` — consolidated report behavior.
- `packages/coding-agent/test/codex-usage-routing.test.ts` — command routing and existing usage behavior.

## Known gaps (current cycle)

- [ ] Verify the requirements against passing tests once the concurrent implementation is complete;
      checklist items remain unchecked until that evidence exists.

## Out of scope

- Routing, quota-fallback, or authentication changes; this feature only reports existing usage.
- Switching providers or Claude accounts, or changing the selected model; selection is displayed only.
- Inferring quota independence from provider IDs or deduplicating providers by email; neither establishes
  whether upstream quotas are shared.
