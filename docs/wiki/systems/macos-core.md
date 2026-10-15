# Native macOS core implementation

Contract: [Native macOS core](../../specs/macos-core.md). Snapshot: 2026-10-14. Native evidence: Osso/pi Actions run `38651327008`, revision `bcaee48e5`, workflow `.github/workflows/macos-core.yml`; `macos-15` arm64 passed in 2m51s and `macos-15-intel` x64 in 6m41s. Run `38658162451` at `d6635a884` repeated all results through the standard `npm run build`. Release execution and native deployment rollback remain unproven.

## Process representation

`ProcessIdentity` still contains numeric `pid`, numeric `startTimeTicks`, and optional runtime `incarnation`; no separate Darwin ownership type or storage migration is introduced. The marker's units are platform-specific, not interchangeable durations:

| Platform | `startTimeTicks` source | State/group source |
|---|---|---|
| Linux | `/proc/<pid>/stat` kernel start jiffies | Same stat record |
| Darwin | `pbi_start_tvsec * 1_000_000 + pbi_start_tvusec` | Public SDK `proc_pidinfo(pid, PROC_PIDTBSDINFO, ...)` result |

`runtime-process.ts` dispatches by OS. `runtime-process-darwin.ts` loads `native/darwin/prebuilds/darwin-<arm64|x64>/process-info.node` relative to the coding-agent package root and validates the returned PID, positive safe-integer creation marker, recognized state, and nonnegative safe-integer group ID.

The coding-agent-owned C addon checks the full `proc_bsdinfo` result size and PID, bounds microseconds and safe-integer arithmetic before conversion to a JavaScript number, and maps kernel zombie state `5` to `Z`; other returned kernel states map to `R`. Native inspection errors carry codes. Darwin liveness returns false for `ESRCH`, a marker mismatch, or zombie/exited state; other failures propagate. Existing command-line inspection for runtime classification is not an identity fallback.

On real Darwin kernels, `proc_pidinfo(PROC_PIDTBSDINFO)` returns `ESRCH` for unreaped zombies: XNU excludes them, so they surface as absent and liveness is false. The C zombie-state mapping remains; Linux retains the readable procfs marker. Persisted ownership and incarnation comparisons retain their existing semantics. Native tests prove exact marker matching and +1 mismatch rejection, not an actual kernel PID-reuse event. See [lifecycle contract](../../specs/agent-lifecycle.md).

## Detached payloads and capability limits

`detached-job-bootstrap.ts` now reads process-group ID through `readProcessGroupId()` rather than directly parsing Linux procfs. It writes and syncs the identity before opening the execution gate. Bootstrap tests now support Linux and Darwin, including an explicit Bun subprocess probe; native tests passed identity/group persistence before release, `pgid == pid`, and ordered payload output on both architectures.

Artifact cleanup is a different capability: `detached-job-cleanup.ts` requires Linux `/proc` references to executable, cwd, and open descriptors. On Mac it skips reference-safe eviction rather than deleting with weaker evidence. This preserves artifacts but does not enforce Linux's age/size retention policy on Mac.

Missing/default and `full-access` sandbox profiles execute unsandboxed. Explicit `read-only` and `workspace-write` profiles are unsupported off Linux and fail closed before bubblewrap execution. Standard agent types and the resident Supervisor do not force a sandbox. Architect explicit readonly policy is optional, not a supported macOS core claim. Existing direct Supervisor startup and optional systemd management are unchanged. Profile details belong to the [sandbox spec](../../specs/bwrap-sandbox.md).

## Native assets and rollback

`native/darwin/build.mjs` uses `xcrun` to select the SDK and compile the process addon with public SDK headers and libproc, for arm64 or x64. Non-Darwin compilation skips without producing assets. Asset checking/copying requires an existing prebuild; it does not invent one or substitute process identity. Package integration is implemented: the coding-agent build invokes the native builder, npm includes source and available prebuilds, and host binary builds check/copy the host addon. Both `prepublishOnly` and `scripts/publish.mjs` require arm64/x64 assets; the publisher checks before any npm query, pack, or publish even with lifecycle scripts disabled. Linux development builds do not require Mac assets. Release CI obtains actual Mac prebuilds from the native validation job; publication still requires successful validation and artifact availability. `scripts/build-binaries.sh` checks requested Darwin process and terminal prebuilds before invoking Bun or replacing output, then copies both addons at package-root loader paths. Native process and Tui bundles were verified as Mach-O arm64/x86_64. Merged `macos-native-arm64`/`macos-native-x64` artifacts passed `build.mjs check darwin-arm64 darwin-x64` and Tui asset preflight. Packed npm tarballs installed outside the checkout and compiled host Bun binaries passed `--help` and `--version` on both architectures. The `--version` import of `session-control-db.ts` performs module-load `readProcessIdentity(process.pid)`, proving installed-layout native addon loading (import chain verified locally).

Deployment rollback targets preservation of prior launcher inode/link/bytes, or launcher absence on first installation without a dangling link. Source and controlled rollback fixtures cover this boundary; they do not prove native Mac deployment.

## Actual macOS CI

`.github/workflows/macos-core.yml` supports `workflow_dispatch` and reusable `workflow_call`, with optional `source_ref`. Standard `macos-15` arm64 and `macos-15-intel` x64 runners use Node 22 and Bun 1.4.0. Package builds compile process prebuilds against the real SDK; each runner separately compiles and loads its host Tui addon. Vitest runs under Node; explicit Bun probes and headless CLI processes exercise Bun, not Bun-hosted Vitest.

`RpcClientOptions.executablePath` defaults to `node` and accepts a Bun executable. Fixture-only `PI_HEADLESS_RUNTIME=node|bun` selects the actual headless CLI and compatible preload flags; invalid values fail explicitly. See [RPC client options](../../../packages/coding-agent/docs/rpc.md#typed-nodejs-client) and [headless fixture contract](../../specs/headless-pi-test-fixture.md).

Native identity/bootstrap passed 5/5 per architecture, including the explicit Bun subprocess adapter/bootstrap probe. Headless scenarios passed 8/8 per runtime per architecture: invalid selectors (2), main/child runtime identity, persisted goal restoration in a replacement process plus offline Supervisor completion review, thinking live-child crash/restart, live Bash and canonical Pyrun runner reattachment (`Osso/pyrun@0c6a16f4` via uv), and foreground Bash backgrounding across `/restart`. Node-hosted Vitest selects actual Node then Bun Pi processes through `PI_HEADLESS_RUNTIME`.

Production `ensureSupervisorRunning` with isolated inert Sol auth started, concurrently reused, and exited one resident per runtime on each architecture; zero fetch/WebSocket requests. Runtime scenarios use offline faux-provider control; dependency installation is not offline.

Native-run fixes: `TMPDIR=/tmp` avoids Darwin fixture socket paths reaching 112 bytes beyond the 104-byte `sun_path` limit; provider buffering is per connection so a crashed process's partial line cannot corrupt a replacement request under macOS 8 KiB chunks (`headless-provider-server.test.ts` supplies Linux regression proof). `npm run build` compiles committed model catalogs and no longer fetches provider APIs (regeneration is manual), so validation and release builds no longer depend on live catalog drift; native CI asserts the build leaves `packages/ai/src` unchanged.

`build-binaries.yml` calls native validation at the release source ref before binary builds. Binary build and npm publication jobs download `macos-native-*` artifacts into `packages` with merged contents, restoring both architectures' process and Tui assets at package-root loader paths. This is configured handoff, not proof of a completed release or publication.

## Capability and proof matrix

Independent Linux integration passed 92 tests across eight files and two selected real-process crash/restart scenarios, with the faux provider. The final integrated `npm run check` passed after all publication/status changes and readability fixes: exit 0, 1,199 files, no fixes. Final changed-scope batches passed 93 cases and the last adjusted status file passed 24 cases; these overlap earlier proof. Prior sandbox slice proof also covers real Linux bwrap enforcement (39 tests including `bwrap-extension.test.ts`). These overlapping runs are not additive and do not prove native Darwin execution.

| Capability | Evidence at `bcaee48e5` unless noted | Mac Node | Mac Bun |
|---|---|---|---|
| Process/Tui addon build and loading | Real `xcrun` SDK builds, both architectures; explicit missing-asset failure; controlled loader/ABI/error tests remain supplementary | Passed arm64/x64 | Passed arm64/x64 |
| Exact identity, exec, zombie liveness, gated payload | `runtime-process.test.ts`, `detached-job-bootstrap.test.ts`, `native-process-probe`: 5/5 per architecture; Bun subprocess probe | Passed arm64/x64 | Passed arm64/x64 |
| Default/full-access file ops; protected profiles fail closed | `bwrap-platform.test.ts`, `approval-selector.test.ts`, `session-sandbox-profile.test.ts`: 39/39 on real macOS, Node-hosted Vitest | Passed arm64/x64 | No separate Bun-hosted sandbox suite |
| Installed native layout and CLI startup | External-checkout npm install; compiled host Bun binary; `--help`/`--version`; Mach-O verification and merged release preflight | Passed arm64/x64 | Passed arm64/x64 |
| Goal restoration, live child, Bash/Pyrun restart | `headless-runtime.test.ts`: 8/8 per runtime per architecture | Passed arm64/x64 | Passed arm64/x64 |
| Production resident autostart/reuse/exit | `supervisor-autostart-runtime.test.ts`: one resident per runtime/architecture, zero provider requests | Passed arm64/x64 | Passed arm64/x64 |
| Tagged release gating/publication | Native artifact download wired before build/publish; merged layout verified; publishing workflow not executed | Unproven end-to-end | Unproven end-to-end |
| Launcher rollback | `deploy-resident-services.test.ts`: 38 Linux-controlled fixture cases | Not executed on Mac | Not executed on Mac |
| Reference-safe artifact eviction | Linux-only procfs implementation | Unsupported, safely skipped | Unsupported, safely skipped |

Procfs descriptor assertions and controlled C bridge tests remain Linux-only. `headless-provider-server.test.ts` covers the provider-buffering regression on Linux; native headless scenarios exercise the corrected connection boundary. Native passing results above establish only their named scenarios, not release publication, deployment rollback, actual PID reuse, or full platform parity.
