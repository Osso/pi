# Pyrun console streaming

[Contract](../../specs/pyrun-console-streaming.md).

## Foreground flow

[eval-tool.ts](../../../packages/coding-agent/extensions/pyrun/src/eval-tool.ts) sends `stream_console: true` to the canonical JSONL runner. [PyrunRunnerClient](../../../packages/coding-agent/extensions/pyrun/src/runner.ts) parses complete JSONL records in arrival order: progress goes to `onProgress`, while `completed`, `error`, or `needs_approval` settles the pending evaluation. Console events carry stream and text; Pi accumulates them rather than separating stdout and stderr into reordered blocks.

`createPyrunProgressReporter` emits cumulative console text through tool updates. It retains recent output within 300 newline-based lines and 1,048,576 UTF-8 bytes, including a bounded tail of oversized newline-free text. Terminal console history is bounded separately before formatting. The canonical runner supplies flushed partial text; Pi does not implement Python buffering itself.

[index.ts](../../../packages/coding-agent/extensions/pyrun/src/index.ts) renders submitted Python in the call immediately. Result rendering removes the repeated executed-code prefix from formatted output. Final output replaces partial output, rather than appending the full console history a second time.

## Durable flow and timing

[detached-evaluation.ts](../../../packages/coding-agent/extensions/pyrun/src/detached-evaluation.ts) launches or restores a durable runner and observes append-only artifacts. Cursor reads consume bounded chunks and retain incomplete records. Directory activity wakes observation; a one-second timer remains available, and unread bytes are drained before waiting.

[detached-progress.ts](../../../packages/coding-agent/extensions/pyrun/src/detached-progress.ts) batches dense same-stream console records for live updates, flushing at stream changes or terminal records. The artifact retains original records subject to the cap below. Durable and direct paths use the same visible progress formatter.

[Agent-loop timing](../../../packages/agent-core/src/agent-loop.ts) supplies one invocation start timestamp. [Tool wrapping](../../../packages/coding-agent/src/core/tools/tool-definition-wrapper.ts) exposes it as `ctx.toolExecutionStartedAt`; durable launch metadata preserves it. [Detached settlement](../../../packages/coding-agent/extensions/pyrun/src/detached-runner.ts) calculates terminal duration from that original timestamp for success, error, or cancellation.

## Durable log retention

[detached-output.ts](../../../packages/coding-agent/extensions/pyrun/src/detached-output.ts) owns the Pyrun `output.log` writer. It appends complete JSONL progress records until the next record would exceed a 25 MiB head budget, then buffers a rolling whole-record tail. Tail bytes are bounded by 50 MiB minus the actual head size. Oversized individual progress records are evicted whole, not split into invalid JSON. Nothing already appended is rewritten, so live byte offsets remain valid.

At settlement, the writer makes room for the exact terminal record by evicting oldest tail records, reserving 256 bytes for a truncation marker. If records were omitted, it appends the marker (`kind`, `message`, `omittedBytes`, `omittedRecords`), then retained tail and terminal. Counts cover serialized JSONL bytes including newlines, not just console text. A completed job whose entire artifact fits within 50 MiB remains byte-identical, although progress beyond the head is delayed until settlement. Mandatory terminal data takes priority: if head + terminal cannot fit, the whole tail is dropped and head + marker + terminal is written in full. This is the only cap exception; overflow is bounded by those mandatory bytes, not by progress volume.

Manifest resume reattaches to the existing runner rather than creating another writer. A supervisor restart therefore does not lose its in-memory tail. Runner death before settlement loses the unflushed tail and in-memory omission counters; intentionally evicted middle records are already discarded. The durable prefix survives and replay returns `lost_runtime` unless a complete terminal record was written. Death during final appends can additionally leave a complete marker/partial tail or an incomplete last JSONL record; existing readers ignore incomplete final lines. No result is fabricated, and no historical prefix is truncated. Bridge requests/responses, activation, launch manifests, and control-DB finalization use separate files/state and are not capped or buffered by this writer. Bash uses direct raw stdout/stderr file descriptors and does not share this writer.

The writer deliberately serializes the supplied terminal payload unchanged. Console history is duplicated there, not removed by streaming: the local canonical Pyrun source (`/home/osso/Projects/claude/pyrun/pyrun/runtime.py`, `SessionStore.evaluate`, inspected 2026-10-20) retains the latest 300 console entries, with no byte bound in `record_console`. Thus ordinary short-line output is not duplicated in full, but up to 300 very large entries can still exceed the cap via the mandatory terminal exception. Pi's 1 MiB console bound is applied by the display formatter after persistence. No canonical runner or terminal format changes are part of this work.

## Limits

These console bounds are not a promise that the model receives 1 MiB: generic tool wrapping also truncates visible text and spills full formatted output to a file. Streaming is record/line-oriented, not byte-by-byte or OS pipe streaming. The extension registers only when its runner executable is available. Canonical runner `tests/test_jsonl.py` is outside this checkout and was not run for the log-cap change; the console-history source inspection above is not runtime verification.

## Test evidence

[Log-cap tests](../../../packages/coding-agent/test/detached-pyrun-log-cap.test.ts) exercise real runner processes past 50 MiB, including byte counts, tail order, immutable live prefix, exact under-cap bytes, terminal-priority overflow, live and completed manifest replay, error settlement, detached control-DB finalization, and killed-runner recovery. No lifecycle ownership or listener semantics changed; these tests exercise the log boundary rather than adding a supervisor-restart scenario.

Other coverage: [pyrun-extension.test.ts](../../../packages/coding-agent/test/pyrun-extension.test.ts) asserts output before completion, stdout/stderr order, partial text, bounded tails, final rendering, and dense artifact retention. [Post-restart regression](../../../packages/coding-agent/test/suite/regressions/post-restart-pyrun-memory.test.ts) exercises large output in a restored child while its parent waits. [Detached artifact tests](../../../packages/coding-agent/test/detached-job-runner.test.ts) check persisted terminal duration; [wrapper tests](../../../packages/coding-agent/test/tool-definition-wrapper.test.ts) and [agent-loop tests](../../../packages/agent-core/test/agent-loop.test.ts) locate shared timing coverage.
