# Ask questions

Contract: [Ask questions tool](../../specs/ask-questions-tool.md).

## Flow

[`ask-questions.ts`](../../../packages/coding-agent/src/core/tools/ask-questions.ts) defines a sequential built-in tool with `approvalRequired: false`. It requires both `ctx.hasUI` and `ctx.mode === "tui"`; RPC having UI support is not sufficient. [`tools/index.ts`](../../../packages/coding-agent/src/core/tools/index.ts) registers it among default active tools.

The schema bounds requests to 1–4 questions and 2–4 options per question. Execution also rejects duplicate question text and duplicate option labels. Questions run in order through `ctx.ui.select`. Numbered labels display optional descriptions; results contain the original option labels, keyed by full question text.

`Other` opens `ctx.ui.input`; custom answers are trimmed and empty input cancels a single-select question. Multi-select repeatedly toggles a set of labels, accepts custom answers, and finishes through `Done`; answers are comma-separated strings, not arrays. An empty selection is valid. Cancelling preserves already answered questions in details and sets `cancelled: true`.

A desktop notification opens before the question loop and closes in `finally`. Notification failures are logged without preventing questions. Call/result renderers reuse a `Text` component for compact summaries.

## Limits and evidence

Dedicated option preview rendering is **unimplemented**. `preview`, `header`, and caller `metadata` survive in result details, but selection dialogs use question text and option descriptions rather than a preview pane. No non-TUI answer relay exists.

[`ask-questions-tool.test.ts`](../../../packages/coding-agent/test/ask-questions-tool.test.ts) contains registration, validation, label/custom/multi-select answers, cancellation, mode rejection, and notification-lifecycle assertions. [`plan-mode-extension.test.ts`](../../../packages/coding-agent/test/plan-mode-extension.test.ts) covers plan-mode integration. Tests inspected, not run.
