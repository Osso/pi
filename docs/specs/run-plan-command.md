# Run-Plan Command

Module boundary: first-party extension module (`packages/coding-agent/extensions/run-plan/`).

The `/run-plan` slash command automates checklist-driven work by reading `PLAN.md` (or a user-specified file), finding the first unchecked `- [ ]` or `* [ ]` item, and submitting it as the next user message via `pi.sendUserMessage()`. After the agent finishes, the active plan is checked again and the next unchecked item is submitted as a follow-up until no unchecked items remain. The command is registered as a first-party extension module via `pi.registerCommand("run-plan", {...})`. Source lives in `packages/coding-agent/extensions/run-plan/src/index.ts`. An active plan file is signaled to downstream hooks by writing the plan filename and path into a well-known entry in extension state via `pi.appendEntry("run-plan:active", { file, path })`; callers can also inspect `process.env.PLAN_FILE`/`process.env.PLAN_PATH` and legacy `PI_PLAN_*` variables, which the handler sets before submission. See [docs/wiki/systems/run-plan-command.md](../wiki/systems/run-plan-command.md) for how it works.

## What it must do

### Command registration
- [x] `run-plan` is implemented as a first-party extension package under `packages/coding-agent/extensions/run-plan`, matching the `/goal` extension boundary.
- [x] The `run-plan` command is registered via `pi.registerCommand("run-plan", { description, handler, getArgumentCompletions })` and appears in the `/` command list when the first-party extension is loaded.
- [x] An optional inline filename argument is accepted; when absent, `PLAN.md` in the session cwd is used.
- [x] `getArgumentCompletions` completes `.md` filenames from the session cwd.

### Plan-item extraction
- [x] The first `- [ ]` or `* [ ]` line (unchecked item) in the plan file is found and returned as the prompt text.
- [x] Already-checked items (`- [x]`, `* [x]`, case-insensitive `X`) are skipped.
- [x] When all items are checked, no message is submitted and a visible notice is shown to the user.
- [x] When the plan file does not exist, a command error is thrown (not a silent no-op).

### Prompt submission
- [x] The extracted item text (stripped of the checkbox prefix) is submitted via `pi.sendUserMessage(text)` with an instruction not to read `PLAN.md`; the command already selected the item.
- [x] After an active plan agent run ends, the current first unchecked item is submitted again as a follow-up if it remains unchecked; if the previous item was checked, the next unchecked item is submitted.
- [x] The active run stops when the plan file is missing or no unchecked items remain.
- [x] The composer / input buffer is cleared after dispatch (no residual text shown).

### Active-plan signaling
- [x] `process.env.PLAN_FILE` is set before submission so hook scripts can read which plan is active.
- [x] When the default `PLAN.md` is used, `PLAN_FILE` is set to `"1"` to match Codex `/run-plan` hook semantics.
- [x] When an explicit plan filename is used, `PLAN_FILE` is set to the plan filename basename.
- [x] `process.env.PLAN_PATH` is set to the resolved plan path so follow-up hooks do not depend on process cwd.
- [x] Legacy `process.env.PI_PLAN_FILE` and `process.env.PI_PLAN_PATH` are also set for Pi-local callers.
- [x] The active plan filename and resolved path are appended as a session entry via `pi.appendEntry("run-plan:active", { file, path })` for in-process hook extensions.

### Error reporting
- [x] A missing plan file throws a command error.
- [x] `/run-plan` is blocked while a task is already running.

## How it works

- [docs/wiki/systems/run-plan-command.md](../wiki/systems/run-plan-command.md) (stub — not yet written).

## Implementation inventory

- `packages/coding-agent/extensions/run-plan/package.json` — First-party extension package manifest.
- `packages/coding-agent/extensions/run-plan/src/index.ts` — Extension factory: registers the `run-plan` command, implements `findNextPlanItem()`, handles plan-file argument resolution, env export, and session entry append.
- `packages/coding-agent/src/main.ts` — Loads the first-party run-plan extension factory.

## Tests asserting this spec

- `packages/coding-agent/test/run-plan-extension.test.ts` — command registration, markdown completions, unchecked item extraction, checked-item skipping, missing-file errors, complete plan notices, running-task blocking, prompt submission, composer clearing, and active-plan signaling.

## Known gaps (current cycle)

- [x] Create `packages/coding-agent/src/extensions/run-plan.ts` extension factory.
- [x] Implement `findNextPlanItem(filePath: string): Promise<string | null>` — reads file, walks lines, returns first unchecked item text or null.
- [x] Wire `getArgumentCompletions` to list `.md` files in cwd.
- [x] Set `process.env.PLAN_FILE`, `process.env.PLAN_PATH`, legacy `PI_PLAN_*`, and call `pi.appendEntry("run-plan:active", { file, path })` before `pi.sendUserMessage()`.
- [x] Surface the extension via `packages/coding-agent/src/extensions/run-plan.ts`; callers can load it through `extensionFactories` or extension path configuration.
- [x] Write unit tests for `findNextPlanItem`: checked skip, all-checked no-op, missing file error.

## Out of scope

- Mutating PLAN.md to mark items checked (Pi's agent does that; the command only reads).
- Multi-file plan queues or plan switching mid-session.
