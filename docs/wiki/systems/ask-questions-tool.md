# Ask questions

Contract: [Ask questions tool](../../specs/ask-questions-tool.md).

## API and panel

[`ask-questions.ts`](../../../packages/coding-agent/src/core/tools/ask-questions.ts) defines a built-in tool with `approvalRequired: false` and sequential tool execution. It requires both `ctx.hasUI` and `ctx.mode === "tui"`; RPC UI support is insufficient. [`tools/index.ts`](../../../packages/coding-agent/src/core/tools/index.ts) registers it among default active tools.

Every call requires `blocking: true` or `false`. Requests contain 1–4 unique questions. Supplied `options` must contain 2–4 unique labels; omission selects free-text input, not fabricated choices. Free-text questions reject `multiSelect: true`. Optional headers, descriptions, previews and metadata remain supported; previews have no dedicated pane.

[`ask-questions-panel.ts`](../../../packages/coding-agent/src/core/tools/ask-questions-panel.ts) renders one custom tabbed panel, not sequential select dialogs. Multiple questions or a multi-select question add a Submit tab. Single single-select choice and free-text requests return on answering. Choice panels append Other with inline input; multi-select toggles labels and returns comma-separated strings, with an empty selection allowed. Earlier answers remain editable. Free-text drafts survive navigation; submission requires nonblank trimmed text. Tab/Shift+Tab navigate while arrows edit text. Escape cancels from free text; in Other input it returns to choices. Cancellation retains partial answers.

## Scheduling and inbox

A process-local WeakMap keyed by UI context chains panel promises. Requests share this serial queue in both modes; a failed panel does not strand later requests. A desktop notification opens when a panel is shown and closes when it settles. Notification failures are logged without preventing questions.

`blocking: true` awaits the panel and returns answers/cancellation in tool details. It sends no separate inbox reply.

`blocking: false` first captures the control DB path, persisted session path, and originating session/agent address. Missing persistence or control DB fails before a panel opens. It queues the panel and returns `queued: true`, `requestId: toolCallId`, empty answers and `cancelled: false`; this is acceptance, not a completed answer. The agent may continue only independent authorized work.

After submission or cancellation, the tool formats a reply containing the request ID and answers, then calls `enqueueStoredRuntimeMailboxMessage`. Panel failures produce a correlated failure reply. The stored reply uses message ID `ask_questions:<requestId>` and routes to the captured recipient even after an active-session switch. Mailbox write failures are logged and shown through UI notification.

Pending panels and queued UI requests are **process-local**, like the current panel. Only submitted results use the durable mailbox. Restart does not recover unanswered questions; this change adds no durable question lifecycle.

## Prompting and rendering

Guidance requires all user questions through the tool, including free text, never chat. Callers explicitly choose blocking when progress depends on an answer or nonblocking when independent work can continue. Choice callers omit Other; recommended choices go first with `(Recommended)` in the label.

Call rows retain questions and blocking answers/cancellation even with hidden tool output. Nonblocking call rows display `(queued)`; later results arrive separately through the runtime inbox rather than rewriting the completed tool result.

## Evidence

- [`ask-questions-tool.test.ts`](../../../packages/coding-agent/test/ask-questions-tool.test.ts): choice/Other/multi-select, tabs, cancellation, modes, notifications and rendering.
- [`ask-questions-async.test.ts`](../../../packages/coding-agent/test/ask-questions-async.test.ts): required blocking, serial requests, mailbox routing/cancellation and persistence prerequisites.
- [`ask-questions-panel-free-text.test.ts`](../../../packages/coding-agent/test/ask-questions-panel-free-text.test.ts): free-text editing, drafts, required input and preserved choice behaviors.
- [`ask-questions-blocking-pty.test.ts`](../../../packages/coding-agent/test/suite/ask-questions-blocking-pty.test.ts): real TUI/model continuation boundary.
- [`plan-mode-extension.test.ts`](../../../packages/coding-agent/test/plan-mode-extension.test.ts): plan-mode integration.

Documentation audit inspected implementation and async/free-text tests; it did not run core tests.
