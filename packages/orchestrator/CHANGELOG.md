# Changelog

## [Unreleased]

### Fixed

- Keep routing extension dialogs to a still-open RPC stream after a later stream for the same instance closes, instead of dropping them
- Stop the instance child process when the Radius disconnect fails during `stop`, instead of dropping the instance record and leaving the child running
- Drain coalesced IPC RPC stream commands without waiting for more socket data, including after initial blank lines.
- Keep RPC stream commands that arrive while the stream is still opening instead of treating them as a new IPC request and closing the connection.
- Decode IPC requests, RPC stream commands and responses as UTF-8 streams so a multibyte character split across socket chunks is no longer replaced with U+FFFD.
- Deliver an RPC stream `extension_ui_response` immediately instead of queueing it behind the command that waits for it, which deadlocked commands such as `new_session` when an extension asked for confirmation.

## [0.80.3] - 2026-06-30
