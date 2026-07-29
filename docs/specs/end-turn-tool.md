# End-turn tool

The built-in `end_turn` tool gives normal coding-agent model turns an explicit completion signal. It is active by default; model turns continue after assistant text without tool calls until a terminating `end_turn` tool batch is executed. How the loop applies this signal belongs in [`docs/wiki/systems/end-turn-tool.md`](../wiki/systems/end-turn-tool.md).

## What it must do

### Tool contract

- [x] Register a built-in `end_turn` tool in the default active tool set.
- [x] Require one nonblank free-form `reason` argument and reject a blank reason.
- [x] Return a terminating tool result when execution succeeds.

### Agent loop

- [x] Continue a normal coding-agent model run after an assistant response containing text but no tool call when `end_turn` is available.
- [x] End the run after a tool batch whose finalized results all request termination, including `end_turn`.
- [x] Keep model errors, aborted turns, and existing explicit termination mechanisms terminal.

## How it works

- [`docs/wiki/systems/end-turn-tool.md`](../wiki/systems/end-turn-tool.md).

## Implementation inventory

- `packages/coding-agent/src/core/tools/end-turn.ts` — defines the built-in tool schema and terminating result.
- `packages/coding-agent/src/core/tools/index.ts` — exports and registers the tool in default tool collections.
- `packages/agent-core/src/agent-loop.ts` — continues text-only responses when the end-turn tool is available.

## Tests asserting this spec

- `packages/coding-agent/test/end-turn-tool.test.ts`
- `packages/agent-core/test/agent-loop.test.ts`

## Known gaps (current cycle)

None.

## Out of scope

- Goal continuation policy and `/goal` lifecycle decisions.
- Resident Supervisor review or completion policy.
- Replacing existing abort, error, steering, or explicit stop-hook behavior.
