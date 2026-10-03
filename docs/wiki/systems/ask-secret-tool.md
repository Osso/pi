# Ask secret

Contract: [First-party ask_secret](../../specs/ask-secret-tool.md).

## Flow

[`ask-secret/src/index.ts`](../../../packages/coding-agent/extensions/ask-secret/src/index.ts) registers an approval-required, sequential extension tool. Its schema is one top-level object with optional `path`, `label`, `record`, and `fields` (MCP servers and Anthropic tool definitions reject a root union); `parseRequest` accepts exactly `{ record, fields }` for browser credentials or `{ path, label }` for a file secret and rejects mixed or incomplete requests. Request validation precedes the interactive-TUI guard; unsupported modes return `status: "unavailable"` without prompting.

Browser requests reject empty/control-character arguments, absolute broker records, and `..` path segments. Fields prompt in order; only password fields use `secret: true`. The provisioner launches `authsudo -u secrets-broker /usr/bin/secrets-broker-admin provision-browser`, passing record/field metadata in arguments and the JSON value array through stdin. Child stdout/stderr are ignored; failure becomes a generic provisioning error. Cancellation before provisioning returns only cancellation metadata.

File requests require an absolute path and nonempty label. `lstat` rejects symbolic-link and non-regular destinations before a single masked prompt. Persistence creates missing parents with mode `0700`, rechecks the destination, opens an exclusive same-directory UUID temporary file with mode `0600`, writes and syncs it, then atomically renames it. Cleanup closes/removes temporary files and reports write and cleanup errors. The payload is the entered value plus one newline; existing newlines in the value are not stripped.

## Trust boundary and evidence

Results contain only path/record/status metadata. Buffers are zeroed; immutable JavaScript strings cannot be securely erased. Existing parent-directory permissions are not tightened, parent symlinks are not prohibited, and later file access is governed by filesystem permissions and subsequent tool authorization—not by this tool.

[`ask-secret.test.ts`](../../../packages/coding-agent/test/ask-secret.test.ts) asserts masked prompts, non-secret results, cancellation, byte content, modes, overwrite, destination rejection, and rename cleanup. **Missing proof:** end-to-end exclusion of secrets from logs and persisted transcripts; result-redaction tests alone do not establish it. Tests inspected, not run.
