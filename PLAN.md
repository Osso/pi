# Goal
- [ ] Deploy sanitized Codex failure diagnostics without changing provider selection, retries, or request outcomes.

# Tasks
- [x] Trace failures in the running 0.80.3 binary and verify exhausted retries.
- [x] Clone authorized Pi source and hydrate dependencies without lifecycle scripts.
- [x] Add allowlisted provider-attempt diagnostic events with behavioral redaction tests.
- [x] Persist metadata-only failure/retry records through existing SDK callbacks.
- [x] Document field availability, log location, and exclusions.
- [ ] Deploy from actual default `master` (user-approved override, 2026-10-09); verify checks, redaction, and runtime health.
- [ ] Restart superseded installed runtimes without cancelling their agents.

# Exclusions
- No provider/model/retry-policy changes, raw messages, stacks, headers, bodies, prompts, tools, credentials, or binary patches.
