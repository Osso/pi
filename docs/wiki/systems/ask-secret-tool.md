# Ask secret

Contract: [First-party ask_secret](../../specs/ask-secret-tool.md).

## Flow

[`ask-secret/src/index.ts`](../../../packages/coding-agent/extensions/ask-secret/src/index.ts) registers an approval-required, sequential extension tool. Its schema is one top-level object with optional `path`, `label`, `record`, and `fields` (MCP servers and Anthropic tool definitions reject a root union); `parseRequest` accepts exactly `{ record, fields }` for browser credentials or `{ path, label }` for a file secret and rejects mixed or incomplete requests. Request validation precedes the mode guard: the tool runs only when `ctx.hasUI` is true and `ctx.mode` is `tui` or `rpc`; other modes return `status: "unavailable"` without prompting. In RPC mode `ctx.ui.input` sends an `extension_ui_request` with `method: "input"` and, for masked prompts, `secret: true` ([`rpc-mode.ts`](../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts)); the client returns the value in `extension_ui_response`.

Browser requests reject empty/control-character arguments, absolute broker records, and `..` path segments. Fields prompt in order; only password fields use `secret: true`. The provisioner launches `authsudo -u secrets-broker /usr/bin/secrets-broker-admin provision-browser`, passing record/field metadata in arguments and the JSON value array through stdin. Child stdout/stderr are ignored; failure becomes a generic provisioning error. Cancellation before provisioning returns only cancellation metadata.

File requests require an absolute path and nonempty label. `lstat` rejects symbolic-link and non-regular destinations before a single masked prompt. Persistence creates missing parents with mode `0700`, rechecks the destination, opens an exclusive same-directory UUID temporary file with mode `0600`, writes and syncs it, then atomically renames it. Cleanup closes/removes temporary files and reports write and cleanup errors. The payload is the entered value plus one newline; existing newlines in the value are not stripped.

## Trust boundary and evidence

Results contain only path/record/status metadata. Buffers are zeroed; immutable JavaScript strings cannot be securely erased. Existing parent-directory permissions are not tightened, parent symlinks are not prohibited, and later file access is governed by filesystem permissions and subsequent tool authorization—not by this tool.

[`ask-secret.test.ts`](../../../packages/coding-agent/test/ask-secret.test.ts) asserts masked prompts, non-secret results, cancellation, byte content, modes, overwrite, destination rejection, rename cleanup, and the TUI/RPC mode guard. [`rpc-ask-secret.test.ts`](../../../packages/coding-agent/test/suite/rpc-ask-secret.test.ts) runs RPC mode as a real process: the `input` frame carries `secret: true`, the file holds the value, and the session JSONL does not. **Missing proof:** exclusion of secrets from logs, and transcript proof for the TUI and browser flows.
