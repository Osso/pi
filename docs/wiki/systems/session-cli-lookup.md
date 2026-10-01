# CLI session lookup

`pi --session <arg>` and `pi --fork <arg>` resolve their argument in `resolveSessionPath()` (`packages/coding-agent/src/main.ts`):

1. A path-like argument (contains `/` or `\`, or ends in `.jsonl`) is used as a session file path, resolved against the invoking cwd.
2. An external session alias is imported and its new Pi session path is used.
3. Otherwise the argument is a session ID: an exact or prefix match among the current project's sessions (`SessionManager.list`) wins; if none matches, the same matching runs over all sessions (`SessionManager.listAll`). Both listings come from control-DB `session_metadata` when it is populated.

`--session` opens the matched file with `SessionManager.open()`, which restores the session's recorded cwd from its metadata. Startup then runs the agent in `sessionManager.getCwd()`, so a session found in another project runs in that project's directory with no prompt or fork. Archived matches are restored to plain `.jsonl` first.

`--fork` copies the matched session into a new session in the invoking cwd.

If the recorded cwd no longer exists, `getMissingSessionCwdIssue()` (`packages/coding-agent/src/core/session-cwd.ts`) reports it. Interactive mode offers the nearest existing parent of the invoking cwd; a self-restart handoff uses that parent automatically; print and RPC modes exit with `MissingSessionCwdError`.

See [`docs/specs/session-cli-lookup.md`](../../specs/session-cli-lookup.md) for the contract and test coverage.
