# Session naming

Session naming is a default first-party extension that lets the model name the current session through the `set_session_name` tool. This document defines the behavior contract; implementation details belong in [`docs/wiki/systems/session-autoname.md`](../wiki/systems/session-autoname.md).

## What it must do

### Naming through the tool

- [x] Expose a `set_session_name` tool that stores a session display name for the current session.
- [x] The extension never issues a provider request of its own; naming costs no extra model call, and no session title is generated outside the model's own turn.
- [x] The tool is available in every mode that owns a session; a session that cannot be named reports an error result instead of failing silently.

### Eligibility and exclusions

- [x] Name only persisted main sessions: a session file must exist and the runtime must not be a child agent.
- [x] Refuse to name ephemeral sessions and child-agent sessions, with an explicit error result.
- [x] Never write a name into a JSONL transcript entry; persist through the existing session-naming behavior in `session_metadata.name`.

### Manual control

- [x] A name set outside the tool (for example `/name` or `--name`) is not overwritten by the tool.
- [x] A name explicitly cleared with `/unname` blocks later tool naming; the session stays unnamed.
- [x] The tool may correct a name it set earlier in the same session.

### Normalization

- [x] Collapse whitespace and newlines into single spaces, trim the result, and bound it to 80 characters.
- [x] Reject an empty or whitespace-only name with an error result. **Word count is not validated.**

## How it works

- [`docs/wiki/systems/session-autoname.md`](../wiki/systems/session-autoname.md) — implementation description.

## Implementation inventory

- `packages/coding-agent/extensions/session-autoname/src/index.ts` — first-party session-naming extension.
- `packages/coding-agent/src/main.ts` — default first-party extension registration.

## Tests asserting this spec

- `packages/coding-agent/test/session-autoname-extension.test.ts`

## Known gaps (current cycle)

None.

## Out of scope

- Automatic naming in print or JSON modes beyond what the model itself requests.
- Naming ephemeral or child-agent sessions.
- Renaming sessions as the conversation evolves, except corrections to a name the tool set itself.
- Replacing manual session naming or defining a title policy beyond the 2–4 word guidance in the tool description.
