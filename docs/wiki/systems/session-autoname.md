# Session naming tool

Contract: [Session naming](../../specs/session-autoname.md).

## Tool surface

[main.ts](../../../packages/coding-agent/src/main.ts) registers the default [session-autoname extension](../../../packages/coding-agent/extensions/session-autoname/src/index.ts), which registers one tool, `set_session_name`, with a single string parameter `name`. The tool description and its prompt guideline ask for a concise 2–4 word title describing the user's request. The extension holds no state beyond the last name it set itself, and it issues no provider request: naming happens inside the model's own turn.

## Write path

The tool normalizes the requested name, then writes it through `pi.setSessionName`. [AgentSession](../../../packages/coding-agent/src/core/agent-session.ts) emits `session_info_changed`; [SessionManager](../../../packages/coding-agent/src/core/session-manager.ts) persists through [control DB name APIs](../../../packages/coding-agent/src/core/session-control-db.ts), not JSONL. `NULL` means never named; an explicit clear stores `''` and blocks further naming. See [session control DB](session-control-db.md).

Refusals return an error tool result instead of writing:

- empty or whitespace-only name;
- child-agent runtime (`ctx.multiAgentAgentId` or a subagent session) — child sessions are not named;
- no session file — ephemeral sessions are not named;
- a name set outside the tool — a manual `/name` or `--name` value is not overwritten;
- a name explicitly cleared — `hasSessionNameState()` is true while the stored name is absent, so the session stays unnamed.

The tool may replace a name it set earlier in the same session.

## Normalization

Newlines and runs of whitespace collapse to single spaces, the result is trimmed, and it is bounded to 80 characters at the last space. **Word count is not validated.** The stored value is the normalized name, so `pi.getSessionName()` and the control DB agree.

## Evidence and limits

[session-autoname-extension.test.ts](../../../packages/coding-agent/test/session-autoname-extension.test.ts) drives the tool through a faux-provider turn: naming and persistence in the control DB, whitespace normalization, refusal for manually named, cleared, child-agent, and ephemeral sessions, empty-name rejection, correction of a tool-set name, and the absence of any extension-initiated provider request.

The extension does not name sessions on its own: a session stays unnamed unless the model calls the tool. Sessions created before this contract keep whatever name they already had.
