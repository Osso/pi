# Pyrun console streaming

Module boundary: first-party Pyrun extension plus the canonical Pyrun JSONL runner.

Pyrun console streaming exposes evaluated Python stdout and stderr through incremental tool updates while retaining canonical console history in the terminal evaluation result.

## What it must do

- [x] Pi requests console streaming from the canonical Pyrun JSONL runner for foreground evaluations.
- [x] The submitted Python code renders immediately in the tool call, before execution starts, and is not emitted as a synthetic tool result.
- [x] Complete stdout lines become visible before evaluation completion.
- [x] Complete stderr lines use the same incremental console-event path.
- [x] Stdout and stderr console events retain protocol arrival order.
- [x] Partial console text delivered by explicit flush or evaluation completion remains visible.
- [x] A `print`, delay, `print` evaluation exposes the first line while the evaluation is still active.
- [x] The final tool result retains console history without duplicating entries inside the rendered final output.
- [x] Streaming output accumulation remains capped to the configured console line limit.
- [x] Foreground streamed and buffered results use the shared tool lifecycle start/end timestamps for elapsed rendering.
- [x] Foreground results, including immediate failures, render elapsed durations below one second in milliseconds.
- [x] Durable foreground evaluations use the same visible progress formatter and console accumulator as direct foreground evaluations.
- [x] Detached success and failure results retain duration from the original foreground tool invocation.
- [x] Detached completion and failure notifications render the persisted duration consistently.

## How it works

- See the canonical Pyrun JSONL protocol documentation in the Pyrun repository.
- See [Tool backgrounding](tool-backgrounding.md) for detachment after foreground streaming begins.

## Implementation inventory

- `packages/coding-agent/extensions/pyrun/src/runner.ts` — parses ordered JSONL progress and terminal messages from the canonical runner.
- `packages/coding-agent/extensions/pyrun/src/eval-tool.ts` — requests console streaming and converts console events into cumulative tool updates.
- `packages/agent-core/src/agent-loop.ts` — captures one invocation start timestamp and passes it through lifecycle events and tool execution context.
- `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts` — exposes the shared invocation start timestamp to extension tool context.
- `packages/coding-agent/extensions/pyrun/src/index.ts` — registers `pyrun_eval` and renders live and final tool output.
- `packages/coding-agent/extensions/pyrun/src/detached-evaluation.ts` — carries the foreground invocation timestamp into durable runner launch metadata.
- `packages/coding-agent/extensions/pyrun/src/detached-runner.ts` — computes one terminal duration for detached success, failure, and cancellation settlement.

## Tests asserting this spec

- `packages/agent-core/test/agent-loop.test.ts`
- `packages/coding-agent/test/tool-definition-wrapper.test.ts`
- `packages/coding-agent/test/detached-job-runner.test.ts`
- `packages/coding-agent/test/session-control-db.test.ts`
- `packages/coding-agent/test/pyrun-extension.test.ts`
- Canonical runner: `tests/test_jsonl.py` in the Pyrun repository.

## Known gaps (current cycle)

None.

## Out of scope

- Byte-by-byte console events; evaluated streams are line-buffered to avoid excessive JSONL and TUI updates.
- OS-level pipe streaming for command-builder pipelines; this contract covers evaluated Python stdout and stderr.
