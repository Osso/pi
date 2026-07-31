# Persisted tool output

Pi applies a persistence-only cap to `toolResult` message entries. The runtime keeps the original tool result; serialized session JSONL lines are capped at 1,048,576 UTF-8 bytes and append `\n[tool output truncated at 1 MiB]` when truncation occurs. UTF-8 prefixes are cut at valid boundaries. The cap is used by normal session writes, full rewrites, forks, relocation writes, and external session imports.

Run the explicit maintenance command to repair existing transcripts:

```text
pi sessions truncate-tool-output
```

The command recursively scans JSONL files under the configured agent directory. It rewrites only valid session files containing oversized tool results, creates a `.tool-output-backup-*` copy before each replacement, and replaces each file atomically. Malformed JSONL, non-session JSONL, and files that fail during migration are skipped and counted in the report. A second run is a no-op for already capped files.

The command checks that each source file stayed unchanged during scanning, preserves file permissions, and does not overwrite a session that changed concurrently. It does not run automatically at startup and does not alter archive metadata or the archive picker.

See [`docs/specs/session-tool-output.md`](../../specs/session-tool-output.md) for the contract and test coverage.
