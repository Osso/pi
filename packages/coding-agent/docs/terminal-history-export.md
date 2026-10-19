# Terminal History Export

Export a saved Pi conversation as ANSI text without opening an interactive session:

```bash
pi --export-terminal /path/to/session.jsonl --export-columns 120
pi --export-terminal <session-id> --export-columns 120
```

Both options are required. Columns must be a positive safe integer. Output goes to stdout; diagnostics go to stderr. Exit status is `0` on success, `4` for an unresolved session ID, and `1` for other failures, including invalid arguments, missing files, and malformed history. External session aliases such as `claude/<id>` are not supported.

The command accepts only `--session-dir` and `--offline` in addition to the two export options. Session-directory precedence is `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, then the global `sessionDir` setting. Global settings are read for session location and theme; project settings and extensions are not loaded. Export runs before normal interactive, provider, and extension initialization, without settings writes, session migration writes, or control-database creation/metadata updates.

## Included history

Export follows the full saved active parent chain, including available pre-compaction ancestors. It excludes discarded sibling branches, hidden custom messages, and non-message state metadata. Legacy sessions are migrated only in memory. Missing ancestors cannot be regenerated: export reports a broken active parent chain rather than inventing history.

Existing message components render user and assistant messages, tool calls/results, bash executions, visible custom messages, and saved compaction/branch summaries. Tools, thinking, and summaries keep their normal collapsed presentation; this is not an expanded raw transcript or an extension-renderer snapshot.

## Terminal output

Output is LF-terminated text wrapped to the requested columns. Renderer-generated SGR colors/styles are preserved; saved terminal controls are sanitized. Export emits no image protocol, cursor movement, screen/scrollback clearing, shell integration, or clipboard control sequences. Image payloads are not rendered.

A consumer can transport this output over a reliable connection such as SSH and write it to its **local** terminal before attaching a live Mosh session. The local writer must translate LF to CRLF when its terminal mode requires it. Export does not itself attach Mosh, preload scrollback, change terminal capacity, or change Pi's live renderer/history lifecycle. Only saved history is available, and the receiving terminal's configured scrollback capacity still applies.

## Source API

`src/core/export-terminal.ts` exposes `exportSessionToTerminal(sessionPath, columns): string` for source integrations. Initialize theme/capabilities before calling it; the CLI handles this initialization. It does not construct an agent or start a terminal. `loadFullSessionBranch(filePath)` in `src/core/session-manager.ts` returns `{ header, entries }` for the complete saved branch without changing the normal compaction-aware session loader or model context. Its entries include non-message state; the exporter selects visible conversation content.

This export is separate from existing `--export` HTML output and interactive `/export`; their behavior is unchanged. See the [feature contract](../../../docs/specs/terminal-history-export.md) and [session format](session-format.md).
