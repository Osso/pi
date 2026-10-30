# T3 Code integration

Module boundary: bundled T3 extension using the generic approval-delegation and RPC contracts.

T3 Code launches Pi in RPC mode and injects an extension that owns T3 approval decisions. The bundled integration is in `packages/coding-agent/extensions/t3-code/`. See [approval system](approval-system.md) and [RPC protocol](../../packages/coding-agent/docs/rpc.md).

## What it must do

- [x] When the bundled integration is loaded in RPC mode and `T3_PI_MCP_EXTENSION_PATH` is set, delegate approvals at `session_start` to the loaded extension at that path. The environment variable alone does not register an authority. Without delegation, retain normal Pi approval semantics, including `never` and `auto-approve`.
- [x] Run unconditional tool gates before delegated approval; a missing or failing authority prevents tool execution.
- [x] Prevent tool execution when authority registrations conflict, including conflicts during extension loading.
- [x] Let the injected T3 extension control its runtime modes: full access permits calls; auto-accept-edits permits reads and edits; ask mode permits reads and asks for other calls. Declined calls are blocked.
- [x] Send typed RPC extension UI responses without waiting for an acknowledgement.

## How it works

- [Approval system](approval-system.md)
- [RPC protocol](../../packages/coding-agent/docs/rpc.md)

## Implementation inventory

- `packages/coding-agent/extensions/t3-code/src/index.ts` — session-specific delegation.
- `packages/coding-agent/src/main.ts` — bundled extension registration.
- `packages/coding-agent/src/core/extensions/` — generic approval authority.
- `packages/coding-agent/src/core/agent-session.ts` — tool gate and approval ordering.
- `packages/coding-agent/src/modes/rpc/rpc-client.ts` — typed UI response transport.

## Tests asserting this spec

- `packages/coding-agent/test/suite/tool-approval-authority.test.ts` — generic authority and native policies.
- `packages/coding-agent/test/suite/rpc-extension-ui-responses.test.ts` — real-process UI responses.
- `packages/coding-agent/test/suite/t3-approval-authority.test.ts` — real-process T3 mode matrix.

On 2026-10-30, the verbatim upstream injected MCP extension at `32ecd71726fee16f335484c1f95cbce126d461f6` passed five tests against each of Pi's source and compiled 1.0.0 runtimes, using an isolated process and localhost MCP server. They cover approval and denial under native `auto-approve`, auto-accept-edits and full-access writes under native `never` without extra prompts, and abort during confirmation without tool execution. They do not run the T3 application or adapter.

The real-process restart regression keeps a child live across production `/restart`, then requires a T3 approval before the restored parent writes a file. It preserves the child's session identity and assignment and checks that completion reaches the parent once.

## Known gaps (current cycle)

None in the tested contract. The T3 application and adapter were not run. The repository process matrix uses a pinned approval-contract fixture; the separate MCP tests load the verbatim upstream injected extension.

## Out of scope

- Changes to T3's injected extension or runtime modes.
- Publishing or deployment.
