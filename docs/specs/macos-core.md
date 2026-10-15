# Native macOS core

Native macOS core removes Linux-only process inspection from core startup and detached payload identity without weakening persisted ownership. Sources live under `packages/coding-agent/src/core/` and `packages/coding-agent/native/darwin/`. See [implementation and proof matrix](../wiki/systems/macos-core.md). Native validation passed in Osso/pi Actions run `38651327008` at `bcaee48e5` on arm64 and x64 with Node 22 and Bun 1.4.0; this is not a full-platform-parity claim.

## What it must do

### Process ownership

- [x] Preserve the existing numeric `ProcessIdentity.startTimeTicks` field and exact `(pid, startTimeTicks, incarnation)` ownership predicates: Linux uses kernel start jiffies; Darwin uses exact kernel process creation microseconds.
- [x] On Darwin, obtain creation time, zombie state, and process-group ID through the public SDK process-inspection API, without PID-only, command-line, or `ps` identity substitution.
- [x] Reject reused PIDs and zombies; treat `ESRCH` as absent, but propagate denied inspection, invalid native data, and binding/ABI failures instead of inferring a dead owner.
- [x] Persist detached payload identity and its OS-derived process-group ID before releasing user code.

### Runtime and packaging

- [x] Build real-SDK process and Tui addons on macOS arm64 and x64 in reusable/manual CI; validate native loading and offline core scenarios with Node 22 and Bun 1.4.0. Missing required assets fail explicitly.
- [ ] Gate release binary builds and npm publication on native validation, restoring both architectures' process and Tui artifacts at their package-root loader paths.
- [x] Start and restart a native macOS supervisor with a live child, preserving exact ownership, session identity, and completion routing.
- [x] Permit default/full-access unsandboxed core execution on macOS; explicitly protected sandbox profiles remain unsupported and fail closed. See [sandbox contract](bwrap-sandbox.md).
- [ ] Failed deployment restores the prior launcher inode/link/bytes, or preserves launcher absence on first install without a dangling link.

Unchecked items retain acceptance gaps: release gating is wired and merged native artifact layout passed preflight, but the publishing tagged workflow was not executed; deployment rollback has Linux-controlled fixture proof only. Native identity tests reject a mismatched creation marker, not an actual kernel PID-reuse event. Darwin unreaped zombies return `ESRCH` and are absent/dead; Linux retains a readable procfs marker.

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
- `.github/workflows/macos-core.yml` and `build-binaries.yml` — native runner validation and release artifact handoff.
- `packages/coding-agent/src/modes/rpc/rpc-client.ts` — optional runtime executable, defaulting to Node; see [RPC client options](../../packages/coding-agent/docs/rpc.md#typed-nodejs-client).
- `packages/coding-agent/test/suite/headless-pi.ts` — fixture-only `PI_HEADLESS_RUNTIME=node|bun` selects the actual CLI runtime.

## Tests asserting this spec

- `packages/coding-agent/test/runtime-process-darwin.test.ts` — six fake-binding adapter cases: identity matching, PID reuse, zombie/absence, inspection denial, group lookup, malformed identity.
- `packages/coding-agent/test/runtime-process-darwin-loader.test.ts` — lazy Linux loading, architecture-specific package paths, binding failures, and malformed-result rejection.
- `packages/coding-agent/test/runtime-process-darwin-binding.test.ts` — thirteen Linux-controlled libproc/N-API cases, including Node and Bun loading, exact numeric encoding, zombie state, errno/ABI failures, and invalid PID inputs.
- `packages/coding-agent/test/runtime-process.test.ts` — real Linux live identity, unreaped zombie, and gated exec preservation; live-self exact marker (+1 rejected), unreaped zombie, group, and real exec preservation passed natively on both architectures.
- `packages/coding-agent/test/detached-job-bootstrap.test.ts` — real Linux/Darwin gated payload, identity persistence, output, release ordering, and explicit Bun subprocess probes; procfs descriptor assertions remain Linux-only.
- `packages/coding-agent/test/bwrap-platform.test.ts`, `approval-selector.test.ts`, and `session-sandbox-profile.test.ts` — 39/39 on native macOS: default/full-access file operations and fail-closed protected profiles, plus labels and persisted-profile status.
- `packages/coding-agent/test/darwin-native-packaging.test.ts` — controlled compiler/assets, npm file inclusion, release archives, and missing-asset preflight; reported 16 passed, not real SDK compilation or Mac package execution.
- `packages/coding-agent/test/darwin-npm-publication.test.ts` — required arm64/x64 asset checks before npm queries, packing, or publication; temporary fixture assets and a mocked npm boundary, not real publication.
- `packages/coding-agent/test/deploy-resident-services.test.ts` — controlled deployment/rollback fixtures, not native Mac deployment.
- `packages/coding-agent/test/suite/headless-runtime.test.ts` — invalid runtime selectors (2), main/child runtime identity, and replacement-process goal restoration with offline Supervisor review.
- `packages/coding-agent/test/suite/headless-pi.test.ts` — selected thinking-child supervisor crash/restart, live Bash and Pyrun runner reattachment, and foreground Bash backgrounding across `/restart`. With `headless-runtime.test.ts`: 8/8 per Node/Bun runtime per architecture.
- `packages/coding-agent/test/suite/supervisor-autostart-runtime.test.ts` — production resident autostart under Node/Bun: one resident concurrently reused and exited per runtime, with zero fetch/WebSocket requests.
- `packages/coding-agent/test/suite/headless-provider-server.test.ts` — Linux regression for per-connection buffering after a crashed process leaves a partial request.
- `packages/coding-agent/test/fixtures/native-process-probe.ts` — explicit Bun subprocess probe of the real identity adapter and gated bootstrap; identity/bootstrap tests passed 5/5 per architecture.

## Known gaps (current cycle)

- [x] Execute native CI: `.github/workflows/macos-core.yml`, Osso/pi run `38651327008`, revision `bcaee48e5`; `macos-15` arm64 succeeded in 2m51s, `macos-15-intel` x64 in 6m41s. Real SDK builds, Node/Bun loading, installed Node tarballs and host Bun `--help`/`--version`, and live-child restart passed.
- [x] Execute offline persisted-goal/restart and production resident-autostart scenarios under Node and Bun on both architectures.
- [x] Complete Linux real-process restart/live-child rerun; two selected scenarios passed.
- [x] Run final integrated `npm run check` after publication/status changes and test readability fixes; exit 0, 1,199 files, no fixes. `npm run build` compiles committed model catalogs without regeneration; run `38658162451` at `d6635a884` passed both architectures through the standard build.

## Out of scope

- Native macOS sandboxing; explicit protected profiles cannot silently become full access.
- macOS artifact eviction: reference-safe cleanup remains Linux-only and safely skips Mac, so age/size retention parity is not provided.
- Architect readonly execution as a supported core capability; it is optional and requires a sandbox unavailable on Mac.
- Resident Supervisor startup redesign or mandatory systemd; existing direct startup and optional systemd behavior remain unchanged.
- Weaker fencing, in-memory recovery, compatibility fallbacks, or unrelated feature changes.
