# Codex paired-provider quota fallback

Module boundary: core subsystem (`packages/coding-agent/src/core/agent-session.ts`).

When an `AgentSession` using `openai-codex` or `openai-codex-gc` receives a terminal quota or
billing exhaustion error, it can continue the same model on the paired provider when that
provider has credentials and exposes the same model ID. This is a session-level recovery path,
not generic provider retry behavior.

## What it must do

### Eligibility

- [x] Detect a terminal quota/usage/billing exhaustion error and select the paired Codex provider
      only when the same model ID is registered there and that model has configured auth.
- [ ] Leave the original error unchanged when the active provider is not a paired Codex provider,
      the paired model ID is missing, or the paired provider has no configured auth.
- [ ] Do not treat unrelated provider errors as quota fallback candidates.

### Continuation

- [x] Remove the failed assistant response from live agent context, switch providers while keeping
      the model ID, and continue the interrupted request.
- [ ] Attempt paired-provider fallback at most once per user turn.
- [ ] Never bounce between paired providers after the fallback attempt has been used in the turn.
- [ ] Reset the fallback guard when the next user message starts a new turn.

## How it works

- [Provider authentication and Codex account setup](../../packages/coding-agent/docs/providers.md#openai-codex)
- [Retry settings](../../packages/coding-agent/docs/settings.md#retry)

## Implementation inventory

- `packages/coding-agent/src/core/agent-session.ts` — detects eligible exhaustion errors, switches
  the model, and drives the continuation guard.

## Tests asserting this spec

- `packages/coding-agent/test/agent-session-retry.test.ts` — paired-provider fallback keeps the
  model ID and retries through `openai-codex-gc` after a usage-limit error.

## Known gaps (current cycle)

- [ ] Add regression coverage for missing paired auth/model, unrelated errors, and the one-at-a-time
      per-turn guard.

## Out of scope

- Generic transient-error retry configuration.
- Provider-level SDK retries.
- Fallback between non-Codex providers or across different model IDs.
