# Pyrun console streaming

[Contract](../../specs/pyrun-console-streaming.md).

## Foreground flow

[eval-tool.ts](../../../packages/coding-agent/extensions/pyrun/src/eval-tool.ts) sends `stream_console: true` to the canonical JSONL runner. [PyrunRunnerClient](../../../packages/coding-agent/extensions/pyrun/src/runner.ts) parses complete JSONL records in arrival order: progress goes to `onProgress`, while `completed`, `error`, or `needs_approval` settles the pending evaluation. Console events carry stream and text; Pi accumulates them rather than separating stdout and stderr into reordered blocks.

`createPyrunProgressReporter` emits cumulative console text through tool updates. It retains recent output within 300 newline-based lines and 1,048,576 UTF-8 bytes, including a bounded tail of oversized newline-free text. Terminal console history is bounded separately before formatting. The canonical runner supplies flushed partial text; Pi does not implement Python buffering itself.

[index.ts](../../../packages/coding-agent/extensions/pyrun/src/index.ts) renders submitted Python in the call immediately. Result rendering removes the repeated executed-code prefix from formatted output. Final output replaces partial output, rather than appending the full console history a second time.

## Durable flow and timing

[detached-evaluation.ts](../../../packages/coding-agent/extensions/pyrun/src/detached-evaluation.ts) launches or restores a durable runner and observes append-only artifacts. Cursor reads consume bounded chunks and retain incomplete records. Directory activity wakes observation; a one-second timer remains available, and unread bytes are drained before waiting.

[detached-progress.ts](../../../packages/coding-agent/extensions/pyrun/src/detached-progress.ts) batches dense same-stream console records for live updates, flushing at stream changes or terminal records. The artifact retains original records. Durable and direct paths use the same visible progress formatter.

[Agent-loop timing](../../../packages/agent-core/src/agent-loop.ts) supplies one invocation start timestamp. [Tool wrapping](../../../packages/coding-agent/src/core/tools/tool-definition-wrapper.ts) exposes it as `ctx.toolExecutionStartedAt`; durable launch metadata preserves it. [Detached settlement](../../../packages/coding-agent/extensions/pyrun/src/detached-runner.ts) calculates terminal duration from that original timestamp for success, error, or cancellation.

## Limits

These console bounds are not a promise that the model receives 1 MiB: generic tool wrapping also truncates visible text and spills full formatted output to a file. Streaming is record/line-oriented, not byte-by-byte or OS pipe streaming. The extension registers only when its runner executable is available. Canonical runner internals and `tests/test_jsonl.py` are outside this checkout and were not verified here.

## Test evidence

Tests inspected, not run: [pyrun-extension.test.ts](../../../packages/coding-agent/test/pyrun-extension.test.ts) asserts output before completion, stdout/stderr order, partial text, bounded tails, final rendering, and dense artifact retention. [Post-restart regression](../../../packages/coding-agent/test/suite/regressions/post-restart-pyrun-memory.test.ts) exercises large output in a restored child while its parent waits. [Detached artifact tests](../../../packages/coding-agent/test/detached-job-runner.test.ts) check persisted terminal duration; [wrapper tests](../../../packages/coding-agent/test/tool-definition-wrapper.test.ts) and [agent-loop tests](../../../packages/agent-core/test/agent-loop.test.ts) locate shared timing coverage.
