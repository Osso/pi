# Native macOS core implementation

Contract: [Native macOS core](../../specs/macos-core.md). Snapshot: 2026-10-14, actual macOS CI phase. Native Actions execution and acceptance proof remain pending; local Mac absence no longer blocks validation through CI.

## Process representation

`ProcessIdentity` still contains numeric `pid`, numeric `startTimeTicks`, and optional runtime `incarnation`; no separate Darwin ownership type or storage migration is introduced. The marker's units are platform-specific, not interchangeable durations:

| Platform | `startTimeTicks` source | State/group source |
|---|---|---|
| Linux | `/proc/<pid>/stat` kernel start jiffies | Same stat record |
| Darwin | `pbi_start_tvsec * 1_000_000 + pbi_start_tvusec` | Public SDK `proc_pidinfo(pid, PROC_PIDTBSDINFO, ...)` result |

`runtime-process.ts` dispatches by OS. `runtime-process-darwin.ts` loads `native/darwin/prebuilds/darwin-<arm64|x64>/process-info.node` relative to the coding-agent package root and validates the returned PID, positive safe-integer creation marker, recognized state, and nonnegative safe-integer group ID.

The coding-agent-owned C addon checks the full `proc_bsdinfo` result size and PID, bounds microseconds and safe-integer arithmetic before conversion to a JavaScript number, and maps kernel zombie state `5` to `Z`; other returned kernel states map to `R`. Native inspection errors carry codes. Darwin liveness returns false for `ESRCH`, a marker mismatch, or zombie/exited state; other failures propagate. Existing command-line inspection for runtime classification is not an identity fallback.

Persisted ownership and incarnation comparisons retain their existing semantics. Numeric encoding and fake PID-reuse rejection are covered by controlled tests; real SDK/kernel reuse-safety remains unverified. See [lifecycle contract](../../specs/agent-lifecycle.md).

## Detached payloads and capability limits

`detached-job-bootstrap.ts` now reads process-group ID through `readProcessGroupId()` rather than directly parsing Linux procfs. It writes and syncs the identity before opening the execution gate. Bootstrap tests now support Linux and Darwin, including an explicit Bun subprocess probe; native Mac gate, persistence, and group results remain pending.

Artifact cleanup is a different capability: `detached-job-cleanup.ts` requires Linux `/proc` references to executable, cwd, and open descriptors. On Mac it skips reference-safe eviction rather than deleting with weaker evidence. This preserves artifacts but does not enforce Linux's age/size retention policy on Mac.

Missing/default and `full-access` sandbox profiles execute unsandboxed. Explicit `read-only` and `workspace-write` profiles are unsupported off Linux and fail closed before bubblewrap execution. Standard agent types and the resident Supervisor do not force a sandbox. Architect explicit readonly policy is optional, not a supported macOS core claim. Existing direct Supervisor startup and optional systemd management are unchanged. Profile details belong to the [sandbox spec](../../specs/bwrap-sandbox.md).

## Native assets and rollback

`native/darwin/build.mjs` uses `xcrun` to select the SDK and compile the process addon with public SDK headers and libproc, for arm64 or x64. Non-Darwin compilation skips without producing assets. Asset checking/copying requires an existing prebuild; it does not invent one or substitute process identity. Package integration is implemented: the coding-agent build invokes the native builder, npm includes source and available prebuilds, and host binary builds check/copy the host addon. Both `prepublishOnly` and `scripts/publish.mjs` require arm64/x64 assets; the publisher checks before any npm query, pack, or publish even with lifecycle scripts disabled. Linux development builds do not require Mac assets. Release CI obtains actual Mac prebuilds from the native validation job; publication still requires successful validation and artifact availability. `scripts/build-binaries.sh` checks requested Darwin process and terminal prebuilds before invoking Bun or replacing output, then copies both addons at package-root loader paths. Controlled packaging tests passed; no fixture asset is a native Mac prebuild, and real Mac packages remain unvalidated.

Deployment rollback targets preservation of prior launcher inode/link/bytes, or launcher absence on first installation without a dangling link. Source and controlled rollback fixtures cover this boundary; they do not prove native Mac deployment.

## Actual macOS CI

`.github/workflows/macos-core.yml` supports `workflow_dispatch` and reusable `workflow_call`, with optional `source_ref`. Standard `macos-15` arm64 and `macos-15-intel` x64 runners use Node 22 and Bun 1.4.0. Package builds compile process prebuilds against the real SDK; each runner separately compiles and loads its host Tui addon. Vitest runs under Node; explicit Bun probes and headless CLI processes exercise Bun, not Bun-hosted Vitest.

`RpcClientOptions.executablePath` defaults to `node` and accepts a Bun executable. Fixture-only `PI_HEADLESS_RUNTIME=node|bun` selects the actual headless CLI and compatible preload flags; invalid values fail explicitly. See [RPC client options](../../../packages/coding-agent/docs/rpc.md#typed-nodejs-client) and [headless fixture contract](../../specs/headless-pi-test-fixture.md).

Current workflow selects real kernel identity/bootstrap tests and three headless live-child/runner restart cases for each runtime. It also packs and installs Node packages outside the checkout, smokes Node CLI startup, and compiles/smokes the host Bun binary. Runtime scenarios use offline faux-provider control; dependency installation is not offline. Forthcoming persisted-goal/restart and actual resident-autostart scenarios must be integrated and executed before their native coverage is claimed.

`build-binaries.yml` calls native validation at the release source ref before binary builds. Binary build and npm publication jobs download `macos-native-*` artifacts into `packages` with merged contents, restoring both architectures' process and Tui assets at package-root loader paths. This is configured handoff, not proof of a completed release or publication.

## Capability and proof matrix

Independent Linux integration passed 92 tests across eight files and two selected real-process crash/restart scenarios, with the faux provider. The final integrated `npm run check` passed after all publication/status changes and readability fixes: exit 0, 1,199 files, no fixes. Final changed-scope batches passed 93 cases and the last adjusted status file passed 24 cases; these overlap earlier proof. Prior sandbox slice proof also covers real Linux bwrap enforcement (39 tests including `bwrap-extension.test.ts`). These overlapping runs are not additive and do not prove native Darwin execution.

| Capability | Existing evidence | Mac Node | Mac Bun |
|---|---|---|---|
| Lazy loader, package paths, missing/malformed bindings | `runtime-process-darwin-loader.test.ts`: 24 Linux-hosted boundary tests | Genuine loading pending | Genuine loading pending |
| Exact identity, reuse mismatch, denied inspection, groups | `runtime-process-darwin.test.ts`: fake binding, Linux host; reported 6 passed | Native kernel pending | Native kernel pending |
| C encoding, zombie state, errno/ABI validation | `runtime-process-darwin-binding.test.ts`: controlled Linux headers/libproc, actual Node/Bun N-API loading; reported 13 passed | Real SDK compile/load pending | Real SDK compile/load pending |
| Live identity and gated payload | `runtime-process.test.ts` + `detached-job-bootstrap.test.ts`: actual Linux processes; included in reported identity slice of 23 | Live-self/zombie/group/exec and bootstrap tests exist; native run pending | Explicit bootstrap/adapter subprocess probe exists; native run pending |
| Default unsandboxed tools; protected-profile denial | `bwrap-platform.test.ts`, `approval-selector.test.ts`, `session-sandbox-profile.test.ts`: simulated Darwin on Linux, including 24 persisted-profile/status cases; prior sandbox slice also passed 39 cases | Native run pending | Native run pending |
| Native asset build/package/publication | `darwin-native-packaging.test.ts`: 16 controlled compiler/package/archive cases; `darwin-npm-publication.test.ts`: 7 required-asset/Node-launch cases, mocked npm, including simulated Windows | Actual prebuild/package pending | Actual prebuild/package pending |
| Supervisor/live child and detached runner restart | `suite/headless-pi.test.ts`: two selected Linux real-process crash/restart scenarios passed | Native scenario pending | Native scenario pending |
| Launcher rollback | `deploy-resident-services.test.ts`: controlled fixtures; reported 38 passed | Native deployment pending | Native deployment pending |
| Reference-safe artifact eviction | Existing Linux-only procfs implementation | Unsupported, safely skipped | Unsupported, safely skipped |

Live-self, zombie, group, gated-exec, and payload-bootstrap tests support Linux/Darwin; procfs descriptor assertions and controlled C bridge tests remain Linux-only. Offline persisted-goal/restart and actual resident-autostart native coverage are forthcoming, not passing proof. All Mac matrix cells remain pending until genuine Actions results identify the tested revision, architecture, runtime, and scenarios. Linux integration results are not native acceptance evidence.
