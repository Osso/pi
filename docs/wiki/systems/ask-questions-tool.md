# Ask questions

Contract: [Ask questions tool](../../specs/ask-questions-tool.md).

## API and panel

[`ask-questions.ts`](../../../packages/coding-agent/src/core/tools/ask-questions.ts) defines a built-in tool with `approvalRequired: false` and sequential tool execution. It requires both `ctx.hasUI` and `ctx.mode === "tui"`; RPC UI support is insufficient. [`tools/index.ts`](../../../packages/coding-agent/src/core/tools/index.ts) registers it among default active tools.

Every call requires `blocking: true` or `false`. Requests contain 1–4 unique questions. Supplied `options` must contain 2–4 unique labels; omission selects free-text input, not fabricated choices. Free-text questions reject `multiSelect: true`. Optional headers, descriptions, previews and metadata remain supported; previews have no dedicated pane.

[`ask-questions-panel.ts`](../../../packages/coding-agent/src/core/tools/ask-questions-panel.ts) renders one custom tabbed panel, not sequential select dialogs. Multiple questions or a multi-select question add a Submit tab. Single single-select choice and free-text requests return on answering. Choice panels append Other with inline input; multi-select toggles labels and returns comma-separated strings, with an empty selection allowed. Earlier answers remain editable. Free-text drafts survive navigation; submission requires nonblank trimmed text. Tab/Shift+Tab navigate while arrows edit text. Escape cancels from free text; in Other input it returns to choices. Cancellation retains partial answers.

## Scheduling and inbox

A process-local WeakMap keyed by UI context chains panel promises. Requests share this serial queue in both modes; a failed panel does not strand later requests. A desktop notification opens when a panel is shown and closes when it settles. Notification failures are logged without preventing questions.

[`interactive-mode.ts`](../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) captures the prior editor-container children and keyboard focus before extension selector/confirm, input, editor and custom dialogs. [`editor-dialog-restore.ts`](../../../packages/coding-agent/src/modes/interactive/editor-dialog-restore.ts) restores those same children and focus on dialog close rather than installing the normal editor unconditionally. An intervening dialog therefore returns to the pending question; its answer can settle the panel, deliver the correlated inbox reply and release later queued questions. Custom overlays retain their separate overlay handling. This changes UI restoration, not agent lifecycle or pending-question persistence.

`blocking: true` awaits the panel and returns answers/cancellation in tool details. It sends no separate inbox reply.

`blocking: false` first captures the control DB path, persisted session path, and originating session/agent address. Missing persistence or control DB fails before a panel opens. It queues the panel and returns `queued: true`, `requestId: toolCallId`, empty answers and `cancelled: false`; this is acceptance, not a completed answer. The agent may continue only independent authorized work.

After submission or cancellation, the tool formats a reply containing the request ID and answers, then calls `enqueueStoredRuntimeMailboxMessage`. Panel failures produce a correlated failure reply. The stored reply uses message ID `ask_questions:<requestId>` and routes to the captured recipient even after an active-session switch. Mailbox write failures are logged and shown through UI notification.

Pending panels and queued UI requests are **process-local**, like the current panel. Only submitted results use the durable mailbox. Restart does not recover unanswered questions; this change adds no durable question lifecycle.

## Child-agent relay

[`question-relay-tools.ts`](../../../packages/coding-agent/extensions/agents-core/src/question-relay-tools.ts), registered by `agents-mailbox`, overrides `ask_questions` by name (extension tools replace built-ins in `AgentSession._refreshToolRegistry`). Main runtimes call the core definition unchanged; renderers and `approvalRequired: false` come from it.

In a child runtime (`multiAgentAgentId` set) the override validates questions and sends one formatted request through the same `contactParent` path as `contact_parent`, with `threadId` `ask_questions:<childAgentId>:<toolCallId>`. A blocking call then polls the child's own runtime mailbox every 500 ms via `takeRuntimeMailboxMessagesForDelivery`, claiming only the row whose store message ID is `ask_questions:<childAgentId>:<toolCallId>`. The child agent ID is part of the key because tool-call IDs are not unique across children sharing one parent store, and mailbox rows are unique per `(session_path, message_id)`. Normal mailbox drains do not run while the tool executes, so the waiting tool is the only consumer. The claimed row is returned in `details.runtimeMailboxDelivery`, so `AgentSession` accepts it with the tool result instead of re-prompting. Abort stops polling.

`answer_question` resolves the target from the shared store, requires it to be an active direct child of the caller, and enqueues a `reply` row with message ID `ask_questions:<agentId>:<requestId>` keyed to the store's persistence session path. The body is `ask_questions_answer` JSON; a nonblocking child reads it from its normal inbox.

Deployed 2026-10-12 at `e1dfeeda6` (installed SHA-256 `e160c456ac32d85af7ff4d8fb70d1643b3ce609b98c4095e7d098c39cbe02652`) locally and on agent-server for `osso` and Allison; the Allison update was the first via `deploy.sh --agent-server`. Four local and three remote mains restarted in place: same PID/start ticks, new hash, `checkStatus=ok`. Evidence: `/tmp/pi-askrelay-{local,osso,allison}-final.json`, `/tmp/pi-askrelay-allisonproc-final.json`.

## Prompting and rendering

Guidance requires all user questions through the tool, including free text, never chat. Callers explicitly choose blocking when progress depends on an answer or nonblocking when independent work can continue. Choice callers omit Other; recommended choices go first with `(Recommended)` in the label.

Call rows retain questions and blocking answers/cancellation even with hidden tool output. Nonblocking call rows display `(queued)`; later results arrive separately through the runtime inbox rather than rewriting the completed tool result.

## Evidence

- [`ask-questions-tool.test.ts`](../../../packages/coding-agent/test/ask-questions-tool.test.ts): choice/Other/multi-select, tabs, cancellation, modes, notifications and rendering.
- [`ask-questions-async.test.ts`](../../../packages/coding-agent/test/ask-questions-async.test.ts): required blocking, serial requests, mailbox routing/cancellation and persistence prerequisites.
- [`ask-questions-panel-free-text.test.ts`](../../../packages/coding-agent/test/ask-questions-panel-free-text.test.ts): free-text editing, drafts, required input and preserved choice behaviors.
- [`ask-questions-blocking-pty.test.ts`](../../../packages/coding-agent/test/suite/ask-questions-blocking-pty.test.ts): real TUI/model continuation boundary; intervening confirm closes back to the original question, whose answer reaches the correlated durable inbox, followed by a later queued question and reply. [`ask-questions-confirm-extension.ts`](../../../packages/coding-agent/test/suite/fixtures/ask-questions-confirm-extension.ts) opens the actual extension `ctx.ui.confirm` selector.
- [`child-ask-questions.test.ts`](../../../packages/coding-agent/test/suite/child-ask-questions.test.ts): real parent/child sessions over one control DB: blocking relay and answer, nonblocking inbox delivery, two children reusing one tool-call ID, abort, main-runtime delegation, non-parent rejection.
- [`plan-mode-extension.test.ts`](../../../packages/coding-agent/test/plan-mode-extension.test.ts): plan-mode integration.

Final acceptance and proof limits are recorded in the [contract](../../specs/ask-questions-tool.md#tests-asserting-this-spec). The confirm regression does not alone prove every dialog path.
