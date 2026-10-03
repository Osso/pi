# Standalone worker runtime

An explicit ephemeral worker mode in `packages/coding-agent/src/main.ts` and the session SDK runs ordinary tools and canonical foreground Pyrun without resident Supervisor or multi-agent orchestration. `--no-session` alone retains its existing behavior.

## What it must do

### CLI and SDK

- [x] Accept `--no-supervisor` only with `--no-session`; reject `--session`, `--session-id`, `--session-dir`, `--fork`, `--resume`, `--continue`, `--name`, and `--export` before session lookup.
- [x] Accept `createAgentSession({ noSupervisor: true })`, default to an in-memory session, and reject persisted session managers or multi-agent orchestration options before creating services.
- [x] Keep ordinary startup and `--no-session` semantics unchanged unless the explicit opt-out is supplied.
- [ ] Refuse persisted session resume/import through runtime APIs in worker mode.

### Execution boundary

- [x] Execute real canonical `pyrun-jsonl` commands and file mutations in a real CLI process with a faux provider and an in-memory session.
- [x] Preserve ordinary `pi.tools.call` from foreground Pyrun, including native file mutation and reading.
- [ ] Do not create orchestration stores, child/attached factories, detach registries, or multi-agent bridge handlers; omit first-party goal, agents-core, agent-viewer, and agents-mailbox orchestration.
- [ ] Skip abandoned-session sweeps, runtime-binding reconciliation, and detached artifact cleanup/recovery.
- [x] Leave mailbox listener, shared-channel cursor, and multi-agent rows empty after worker startup, execution, and hidden API attempts; do not contact resident sockets, start a resident process, or post Supervisor requests.
- [x] Make Supervisor advisory, goal review, agent orchestration, shared coordination, and persisted session resume unavailable; hidden tool/API attempts fail before lookup, startup, or contact.
- [x] Preserve configured approval policy; Supervisor-dependent approval fails closed without consulting a resident or substituting another reviewer/model.
- [ ] Preserve ordinary resource discovery, tools, extensions, accounts, authentication, permissions, and sandbox settings. Existing sandbox profiles retain their Pi-bridge restrictions.

## How it works

- [Supervisor boundary](supervisor-service.md)
- [Foreground Pyrun](pyrun-console-streaming.md)
- [Headless process fixture](headless-pi-test-fixture.md)

## Implementation inventory

- `packages/coding-agent/src/cli/args.ts` — flag parsing, persistence conflicts, help.
- `packages/coding-agent/src/main.ts` — explicit startup opt-out and ordinary extension preservation.
- `packages/coding-agent/src/core/sdk.ts` / `agent-session-services.ts` — SDK opt-out and in-memory default.
- `packages/coding-agent/src/core/agent-session.ts` / `agent-session-runtime.ts` — validation, coordination/recovery suppression, execution guards.
- `packages/coding-agent/src/core/tool-capabilities.ts` — unavailable worker tool names.
- `packages/coding-agent/src/core/extensions/types.ts` / `runner.ts` — extension context opt-out.
- `packages/coding-agent/src/core/tools/ask-supervisor.ts` / `extensions/goal/src/supervisor-review.ts` — direct advisory/review refusal before lookup.
- `packages/coding-agent/extensions/pyrun/src/index.ts` — refuse orchestration/resume bridge APIs before dispatch.

## Tests asserting this spec

- `packages/coding-agent/test/standalone-worker-args.test.ts`
- `packages/coding-agent/test/standalone-worker-sdk.test.ts`
- `packages/coding-agent/test/suite/standalone-worker-runtime.test.ts`
- `packages/coding-agent/test/args.test.ts`
- `packages/coding-agent/test/sdk-session-manager.test.ts`
- `packages/coding-agent/test/suite/headless-pi.test.ts` — ordinary supervisor restart with a thinking child.

## Known gaps (current cycle)

- [ ] Installed-runtime and live delegated Sol verification belong to the integrating main session.
- [ ] Full approval/sandbox/account matrix and independent final gate belong to the integrating main session.

## Out of scope

- Claude plugin argv integration, deployment, resident management, model substitution, or canonical Pyrun runner changes.
- A security sandbox for arbitrary extension JavaScript or Python imports. Worker opt-out controls Pi runtime APIs; configured sandbox/permissions remain authoritative.
- Durable backgrounding or persisted worker transcripts.

## Usage

```sh
pi --no-supervisor --no-session -p "Run this bounded task"
```

```typescript
const { session } = await createAgentSession({ noSupervisor: true });
```

SDK hosts using `createAgentSessionRuntime` must also pass `noSupervisor: true` in its initial options to skip pre-session detached artifact cleanup, and retain the opt-out in their runtime factory. Ordinary configured tools/extensions still load. A configured `llm-approved-deny` or `llm-approved-ask` preset is not rewritten: calls requiring Supervisor review return an explicit denial; inherently read-only native tools retain existing auto-approval.
