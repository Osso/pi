# Goal
- [ ] Deploy sanitized Codex failure diagnostics without changing provider selection, retries, or request outcomes.

# Tasks
- [x] Trace failures in the running 0.80.3 binary and verify exhausted retries.
- [x] Clone authorized Pi source and hydrate dependencies without lifecycle scripts.
- [x] Add allowlisted provider-attempt diagnostic events with behavioral redaction tests.
- [x] Persist metadata-only failure/retry records through existing SDK callbacks.
- [x] Document field availability, log location, and exclusions.
- [x] Deploy from actual default `master` (user-approved override, 2026-10-09): `43e048c00`, `./deploy.sh` exit 0.
- [x] Restart both eligible installed main runtimes; same PIDs execute the deployed artifact, health checks OK.
- [ ] Receive independent verifier 171's final acceptance; do not infer it from deployment or targeted tests.

# Operational proof
Deployment, artifact hash, runtime receipts, and targeted source-test evidence: [provider failure diagnostics](docs/specs/provider-failure-diagnostics.md#deployment-and-operational-proof).

# Exclusions
- No provider/model/retry-policy changes, raw messages, stacks, headers, bodies, prompts, tools, credentials, or binary patches.
