# Resident session role-path metadata cleanup

Approved delta to frozen source `4f9e6f8a4c0065d81b10e7177b28d5082f0bc30d` (2026-10-21).

`prepareResidentSessionFile` must recognize complete `<role>-sessions` path segments with either forward slash or backslash boundaries for both `architect` and `supervisor`. Missing matching metadata is removed even when the session ID is not the role. Existing files, other-role paths, and prefixed/suffixed segment lookalikes remain untouched. Exact role IDs retain their existing cleanup behavior.

Frozen discrepancy: the private helper constructs a RegExp from a template literal whose backslash escaping produces slash-only matching, unlike the public regex literal. The approved fix doubles the template's backslash escaping; no public predicate, filename selection, process lifecycle, or filesystem path preparation behavior changes.

## Focused proof

`packages/coding-agent/test/resident-session.test.ts` calls the exported preparation API with real temporary files and SQLite metadata, without mocks. Four cells cover both roles and both separators. Each seeds six rows, checks file existence, verifies retained metadata IDs and existing file contents, and cleans up its private fixture.

- RED on the frozen-identical module: two slash cells pass; two backslash cells fail because the missing-path row remains.
- Runtime tests must run through `/home/osso/Projects/pi-rust/scripts/test-sandbox.py`. Frozen dependencies are reused read-only; caches are disabled and Vitest uses its native config loader.
- Linux backslash fixture names are literal filesystem filenames, not evidence of Windows preparation support. The Rust Unix-only preparation gap and Rust source-lock/oracle selection are separate and unchanged.

This is a bounded TypeScript behavior delta, not whole-module Rust parity or final acceptance evidence. Exact commit, module SHA256, commands, RED/GREEN logs, and an explicit import route are recorded in `/tmp/pi-rust-repin-resident-session/REPORT.md` under “Approved TypeScript private-regex delta”.
