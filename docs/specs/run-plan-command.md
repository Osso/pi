# Run-Plan Command

The `/run-plan` slash command automates checklist-driven work by reading `PLAN.md` (or a user-specified file), finding the first unchecked `- [ ]` or `* [ ]` item, and submitting it as the next user message via `ctx.sendUserMessage()`. The command is registered as an extension via `pi.registerCommand("run-plan", {...})`. Source will live in `packages/coding-agent/src/extensions/run-plan/index.ts` (planned). An active plan file is signaled to downstream hooks by writing the plan filename into a well-known entry in extension state (Pi has no direct child-process env export path the same way Codex does — instead the extension stores the active plan name in `ctx.appendEntry` so that hook-aware extensions can read it; alternatively, callers can inspect `process.env.PI_PLAN_FILE` which the handler sets before submission). See [docs/wiki/systems/run-plan-command.md](../wiki/systems/run-plan-command.md) for how it works.

## What it must do

### Command registration
- [ ] The `run-plan` command is registered via `pi.registerCommand("run-plan", { description, handler, getArgumentCompletions })` and appears in the `/` command list.
- [ ] An optional inline filename argument is accepted; when absent, `PLAN.md` in the session cwd is used.
- [ ] `getArgumentCompletions` completes `.md` filenames from the session cwd.

### Plan-item extraction
- [ ] The first `- [ ]` or `* [ ]` line (unchecked item) in the plan file is found and returned as the prompt text.
- [ ] Already-checked items (`- [x]`, `* [x]`, case-insensitive `X`) are skipped.
- [ ] When all items are checked, no message is submitted and a visible notice is shown to the user.
- [ ] When the plan file does not exist, a visible error is shown (not a silent no-op).

### Prompt submission
- [ ] The extracted item text (stripped of the checkbox prefix) is submitted via `ctx.sendUserMessage(text)`.
- [ ] The composer / input buffer is cleared after dispatch (no residual text shown).

### Active-plan signaling
- [ ] `process.env.PI_PLAN_FILE` is set to the plan filename (basename) before submission so hook scripts can read which plan is active.
- [ ] The active plan filename is appended as a session entry via `ctx.appendEntry("run-plan:active", { file })` for in-process hook extensions.
- [ ] When the default `PLAN.md` is used, `PI_PLAN_FILE` is set to `"PLAN.md"` (not a sentinel value like `"1"`).

### Error reporting
- [ ] A missing plan file produces a visible inline error message, not a thrown exception that crashes the command handler.

## How it works

- [docs/wiki/systems/run-plan-command.md](../wiki/systems/run-plan-command.md) (stub — not yet written).

## Implementation inventory

- `packages/coding-agent/src/extensions/run-plan/index.ts` (planned) — Extension factory: registers the `run-plan` command, implements `findNextPlanItem()`, handles plan-file argument resolution, env export, and session entry append.

## Tests asserting this spec

(none yet — feature unimplemented)

## Known gaps (current cycle)

- [ ] Create `packages/coding-agent/src/extensions/run-plan/` directory and `index.ts` extension factory.
- [ ] Implement `findNextPlanItem(filePath: string): Promise<string | null>` — reads file, walks lines, returns first unchecked item text or null.
- [ ] Wire `getArgumentCompletions` to list `.md` files in cwd.
- [ ] Set `process.env.PI_PLAN_FILE` and call `ctx.appendEntry("run-plan:active", { file })` before `ctx.sendUserMessage()`.
- [ ] Surface the extension via `packages/coding-agent/src/extensions/run-plan/index.ts` export and register it in the default extension list or document how users load it.
- [ ] Write unit tests for `findNextPlanItem`: checked skip, all-checked no-op, missing file error.

## Out of scope

- Auto-advancing to the next item after the agent completes a turn (requires turn-end hook logic; tracked separately).
- Mutating PLAN.md to mark items checked (Pi's agent does that; the command only reads).
- Multi-file plan queues or plan switching mid-session.
