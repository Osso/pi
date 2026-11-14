# Changelog

## [Unreleased]

### Fixed

- Drain coalesced IPC RPC stream commands without waiting for more socket data, including after initial blank lines.
- Keep RPC stream commands that arrive while the stream is still opening instead of treating them as a new IPC request and closing the connection.

## [0.80.3] - 2026-06-30
