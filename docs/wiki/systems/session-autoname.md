# Session naming tool

Contract: [Session naming](../../specs/session-autoname.md).

## Tool surface

[main.ts](../../../packages/coding-agent/src/main.ts) registers the default [session-autoname extension](../../../packages/coding-agent/extensions/session-autoname/src/index.ts), which registers one tool, `set_session_name`, with a single string parameter `name`. The tool description and its prompt guideline ask eligible persisted main sessions to set a concise 2–4 word title describing the user's request early in the turn. They instruct the model to skip naming for child-agent, ephemeral, already named, and explicitly cleared sessions. A naming refusal must not stop the requested task. The tool remains available in every mode that owns a session, including child-agent and ephemeral sessions; those sessions still receive explicit error results if they call it. Each successful write records its name revision in the tool result details, so the session transcript keeps the tool's last write revision across extension reloads and restarts. It issues no provider request: naming happens inside the model's own turn.

## Write path

The tool normalizes the requested name, then calls `pi.setSessionName` with `null` for the first write or its last successful name revision for a correction. [SessionManager](../../../packages/coding-agent/src/core/session-manager.ts) persists through the [control DB name APIs](../../../packages/coding-agent/src/core/session-control-db/session-metadata.ts), not JSONL. The control DB compares the expected revision and writes the name atomically. A persisted manual rename advances the revision even if it repeats the same title. A clear also advances the revision: `NULL` in the name field means never named, and `''` means explicitly cleared. The tool uses the returned state to report a refusal without polling or retrying. See [session control DB](session-control-db.md).

Refusals return an error tool result instead of writing:

- empty or whitespace-only name;
- child-agent runtime (`ctx.multiAgentAgentId` or a subagent session) — child sessions are not named;
- no session file — ephemeral sessions are not named;
- a name set outside the tool, including a manual rename from another process that repeats the tool's title;
- a name explicitly cleared, including a clear from another process — the session stays unnamed.

The tool can correct a title only if its last successful write is still the current persisted revision.

## Normalization

Newlines and runs of whitespace collapse to single spaces, the result is trimmed, and it is bounded to 80 characters at the last space. **Word count is not validated.** The stored value is the normalized name, so `pi.getSessionName()` and the control DB agree.

## Evidence and limits

[session-autoname-extension.test.ts](../../../packages/coding-agent/test/session-autoname-extension.test.ts) drives the tool through a faux-provider turn: naming and persistence in the control DB, whitespace normalization, refusal for manually named, cleared, child-agent, and ephemeral sessions, empty-name rejection, correction of a tool-set name, and the absence of any extension-initiated provider request.

[session-autoname-external-name.test.ts](../../../packages/coding-agent/test/suite/regressions/session-autoname-external-name.test.ts) covers a distinct rename, an explicit clear, and a same-title rewrite persisted by another process while the session is live. It checks that the tool refuses each overwrite and that a later turn leaves the persisted state unchanged.

The extension does not name sessions on its own: a session stays unnamed unless the model calls the tool. Sessions created before this contract keep whatever name they already had.
