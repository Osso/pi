# Run-plan command

[Contract](../../specs/run-plan-command.md).

## Selection and dispatch

The [run-plan extension](../../../packages/coding-agent/extensions/run-plan/src/index.ts), declared by its [manifest](../../../packages/coding-agent/extensions/run-plan/package.json) and loaded in [main.ts](../../../packages/coding-agent/src/main.ts), registers `/run-plan`. An empty argument selects `PLAN.md`; otherwise the trimmed argument is joined to session cwd. Markdown filename completion reads `process.cwd()`, filters `.md` suffixes and the supplied prefix, then sorts names.

`findNextPlanItem` reads the file and returns trimmed text from the first line matching an unchecked `- [ ]` or `* [ ]` item. It does not parse Markdown structure or mutate checkboxes. Checked items are skipped because they do not match. No selected text produces an informational notice; a missing file throws. The command rejects a non-idle session.

Dispatch sends the selected text with a fixed instruction not to read `PLAN.md` and to check off the exact resolved item. After submission, `runPlan` exports environment state, appends `run-plan:active`, clears the editor, and retains the active plan in the extension instance.

At `agent_end`, an active plan is reread and submitted as a `followUp`. An unchanged unchecked item is submitted again; checking it moves selection to the next item. Intermediate session-continuation boundaries are ignored. When no item remains, the extension clears its active variable and appends a null state entry.

## State restoration

`session_start` clears plan environment variables, scans loaded entries backward for the latest `run-plan:active`, and restores `{ file, path }` if valid. A null or malformed latest entry means no active plan. `PLAN_FILE` is `1` whenever the basename is `PLAN.md`, including an explicitly named default file; other basenames are exported literally. `PLAN_PATH` carries the joined path, while `PI_PLAN_FILE` and `PI_PLAN_PATH` expose the legacy signals.

## Contract gaps and limits

Current source does **not** signal active state before initial submission: environment export and entry persistence occur afterward. If an active file disappears, follow-up throws without clearing active/persisted state; clean stop-on-missing-file is not implemented. Completing a plan persists null state but leaves environment variables set until a later `session_start` clears them.

The dispatch instruction always names `PLAN.md`, even for an alternate file. There is no retry bound for an unchecked item, Markdown code-fence awareness, multi-file queue, or automatic checkbox update. State restoration uses loaded entries, not a dedicated branch-aware plan checkpoint; entries outside a retained compaction slice are unavailable.

## Test evidence

[run-plan-extension.test.ts](../../../packages/coding-agent/test/run-plan-extension.test.ts) contains file-backed fixtures for extraction, alternate files, missing initial files, complete notices, idle blocking, repeated follow-ups, editor clearing, environment signals, relocation restoration, and null-state persistence. Its signaling assertions inspect state after command completion, not before submission. Tests inspected, not run.
