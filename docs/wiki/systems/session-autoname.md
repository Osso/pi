# Session autonaming

Contract: [Session autonaming](../../specs/session-autoname.md).

## Trigger and write path

[main.ts](../../../packages/coding-agent/src/main.ts) registers the default [session-autoname extension](../../../packages/coding-agent/extensions/session-autoname/src/index.ts). Its `message_start` handler accepts a user-role message unless `inputSource` is `extension`. It requires TUI or RPC mode, a session file, no child-agent identity/provenance, an active model, and no stored name state. Empty text is ignored.

The first eligible message launches an unawaited title request from up to 4,000 characters of its text; assistant completion and `agent_end` are not triggers. A factory-local `attempted` flag prevents further launches in that instance. The request captures the active model and model registry, resolves authentication, and calls `completeSimple` with a separate title context, 64 output tokens, and a 15-second timeout per attempt.

The title prompt asks for 2–4 words. Normalization takes the first nonempty line, removes headings/prefixes/wrapping, collapses whitespace, and bounds the result to 80 characters. **Word count is not validated.**

Before writing, the extension rechecks cancellation and stored name state, then calls `pi.setSessionName`. [AgentSession](../../../packages/coding-agent/src/core/agent-session.ts) emits `session_info_changed`; [SessionManager](../../../packages/coding-agent/src/core/session-manager.ts) persists through [control DB name APIs](../../../packages/coding-agent/src/core/session-control-db.ts), not JSONL. `NULL` means never named; an explicit clear stores `''` and blocks future naming. See [session control DB](session-control-db.md).

## Cancellation and failure

`session_info_changed` and `session_shutdown` abort pending generation/backoff, so manual rename/clear wins. Retryable provider failures and timeouts allow three outer attempts with 1s/2s backoff plus up to 250ms jitter. Each provider call permits one internal retry capped at 3s. Permanent errors, delay-cap errors, empty output, and length termination are not retried. Failure logs to stderr; the attempt flag is not persisted.

## Evidence and limits

[session-autoname-extension.test.ts](../../../packages/coding-agent/test/session-autoname-extension.test.ts) was inspected, not run. Faux-provider cases cover naming before the first answer finishes, nonblocking completion, retries/timeouts, manual races, unsupported modes, historical extension activity, and SQLite authority.

There is no semantic “substantive exchange” or successful-answer gate: empty/failed first answers can still receive a title. Older [session author documentation](../../../packages/coding-agent/docs/sessions.md#naming-sessions) describes a later trigger; the source and tests above describe current behavior. No automatic evolving renames or durable failure record exists.
