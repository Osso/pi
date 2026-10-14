# Native macOS core

Native macOS core removes Linux-only process inspection from core startup and detached payload identity without weakening persisted ownership. Sources live under `packages/coding-agent/src/core/` and `packages/coding-agent/native/darwin/`. See [implementation and proof matrix](../wiki/systems/macos-core.md). Native Mac validation remains pending; this is not a full-platform-parity claim.

## What it must do

### Process ownership

- [ ] Preserve the existing numeric `ProcessIdentity.startTimeTicks` field and exact `(pid, startTimeTicks, incarnation)` ownership predicates: Linux uses kernel start jiffies; Darwin uses exact kernel process creation microseconds.
- [ ] On Darwin, obtain creation time, zombie state, and process-group ID through the public SDK process-inspection API, without PID-only, command-line, or `ps` identity substitution.
- [ ] Reject reused PIDs and zombies; treat `ESRCH` as absent, but propagate denied inspection, invalid native data, and binding/ABI failures instead of inferring a dead owner.
- [ ] Persist detached payload identity and its OS-derived process-group ID before releasing user code.

### Runtime and packaging

- [ ] Build and load the coding-agent-owned process addon on macOS arm64 and x64 under both Node and Bun; missing required native assets fail explicitly.
- [ ] Start and restart a native macOS supervisor with a live child, preserving exact ownership, session identity, and completion routing.
- [ ] Permit default/full-access unsandboxed core execution on macOS; explicitly protected sandbox profiles remain unsupported and fail closed. See [sandbox contract](bwrap-sandbox.md).
- [ ] Failed deployment restores the prior launcher inode/link/bytes, or preserves launcher absence on first install without a dangling link.

Unchecked items mark missing native acceptance proof, not missing implementation. Linux integration passed 92 tests across eight files and two selected real-process supervisor-restart scenarios. Linux-hosted fixtures do not establish native macOS execution.

## How it works

- [Native adapter, platform limits, and proof matrix](../wiki/systems/macos-core.md)
- [Lifecycle ownership](agent-lifecycle.md)
- [Detached tool contract](tool-backgrounding.md)

## Implementation inventory

- `packages/coding-agent/src/core/runtime-process.ts` — platform dispatch, exact identity comparison, liveness, and process-group lookup.
- `packages/coding-agent/src/core/runtime-process-darwin.ts` — architecture-specific native loader and returned-data validation.
- `packages/coding-agent/native/darwin/src/process-info.c` — public libproc inspection and N-API encoding.
- `packages/coding-agent/native/darwin/build.mjs` — SDK compilation and required-asset checking/copying; package scripts, `scripts/build-binaries.sh`, and `scripts/publish.mjs` integrate native builds, binary/npm asset preflight, and loader-path copies.
- `packages/coding-agent/src/core/detached-job-bootstrap.ts` — gated payload ownership persistence using OS-aware group lookup.
- `packages/coding-agent/src/core/detached-job-cleanup.ts` — Linux-only reference-safe artifact eviction; skips macOS.
- `packages/coding-agent/extensions/bwrap/src/backend.ts` and `src/index.ts` — unsupported protected-profile rejection and unsandboxed routing.
- `packages/coding-agent/src/core/permissions/presets.ts`, `src/core/extensions/runner.ts`, `src/modes/interactive/interactive-mode.ts`, and `src/modes/interactive/components/sandbox-selector.ts` — platform capability and honest startup, profile-selection, and command reporting.
- `deploy.sh` — rollback of the prior launcher or initial absence.

## Tests asserting this spec

- `packages/coding-agent/test/runtime-process-darwin.test.ts` — six fake-binding adapter cases: identity matching, PID reuse, zombie/absence, inspection denial, group lookup, malformed identity.
- `packages/coding-agent/test/runtime-process-darwin-loader.test.ts` — lazy Linux loading, architecture-specific package paths, binding failures, and malformed-result rejection.
- `packages/coding-agent/test/runtime-process-darwin-binding.test.ts` — thirteen Linux-controlled libproc/N-API cases, including Node and Bun loading, exact numeric encoding, zombie state, errno/ABI failures, and invalid PID inputs.
- `packages/coding-agent/test/runtime-process.test.ts` — real Linux live identity, unreaped zombie, and gated exec preservation; live-self and exec cases can also run on Mac with a real addon, but no Mac pass is recorded.
- `packages/coding-agent/test/detached-job-bootstrap.test.ts` — Linux-only real gated payload, identity persistence, output descriptors, and release ordering.
- `packages/coding-agent/test/bwrap-platform.test.ts`, `approval-selector.test.ts`, and `session-sandbox-profile.test.ts` — simulated Darwin unsandboxed execution, protected-profile denial, unsupported labels, and profile-change status without substitution.
- `packages/coding-agent/test/darwin-native-packaging.test.ts` — controlled compiler/assets, npm file inclusion, release archives, and missing-asset preflight; reported 16 passed, not real SDK compilation or Mac package execution.
- `packages/coding-agent/test/darwin-npm-publication.test.ts` — required arm64/x64 asset checks before npm queries, packing, or publication; temporary fixture assets and a mocked npm boundary, not real publication.
- `packages/coding-agent/test/deploy-resident-services.test.ts` — controlled deployment/rollback fixtures, not native Mac deployment.
- `packages/coding-agent/test/suite/headless-pi.test.ts` — two selected Linux real-process scenarios passed: supervisor restart with a live thinking child and reattachment of a live Bash runner. Not Mac coverage.

## Known gaps (current cycle)

- [ ] Compile against a real macOS SDK and produce actual arm64/x64 prebuilds; controlled Linux fixtures cannot validate SDK layout or kernel behavior.
- [ ] Run Node and Bun native startup, identity, process-group, and supervisor-restart/live-child checks on macOS.
- [x] Complete Linux real-process restart/live-child rerun; two selected scenarios passed. Actual Mac package execution remains unproven.
- [x] Run final integrated `npm run check` after the publication/status changes and test readability fixes; exit 0, 1,199 files, no fixes. All targeted Linux gates passed; native Mac gaps above remain open.

## Out of scope

- Native macOS sandboxing; explicit protected profiles cannot silently become full access.
- macOS artifact eviction: reference-safe cleanup remains Linux-only and safely skips Mac, so age/size retention parity is not provided.
- Architect readonly execution as a supported core capability; it is optional and requires a sandbox unavailable on Mac.
- Resident Supervisor startup redesign or mandatory systemd; existing direct startup and optional systemd behavior remain unchanged.
- Weaker fencing, in-memory recovery, compatibility fallbacks, or unrelated feature changes.
