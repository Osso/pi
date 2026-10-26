# Machine Assistant

The machine assistant is a persistent, user-facing Pi conversation responsible for reminders, bounded machine-maintenance duties, and the permanent agent-server-to-laptop contact role for one OS user on one machine. This is a design under discussion, not an implemented or deployed service. [Reminders](reminders.md) defines the shared follow-up records; this document defines their delivery owner and the assistant's authority.

## What it must do

### Identity and state

- [ ] Maintain one dedicated persistent assistant conversation per user and machine, rather than assigning maintenance to every interactive project session.
- [ ] Keep shared reminders in Pi-owned control-DB records, as specified in [Reminders](reminders.md).
- [ ] Preserve the assistant conversation and durable state across process restarts.
- [ ] Keep active implementation steps, test checklists, and session progress in `PLAN.md`, not in the reminder queue.

### Laptop contact

- [ ] Provide the permanent laptop-side contact for requests from agent-server, instead of requiring unrelated project sessions to act as the contact.
- [ ] Support the reference responsibilities currently held by sessions `01a140f8-bf71-7014-8fdc-5eb7b11d0e7f` and `01a140fc-9f43-758b-8ac8-a88d45250820`, including source-backed research using laptop-local resources. These IDs identify the existing roles, not the future assistant address.
- [ ] Preserve the requesting host/session identity and project when replying, and preserve each request's existing scope and action limits. A contact role does not grant unrestricted operational authority.
- [ ] Preserve source build/revision provenance and distinguish source-backed findings from runtime proof when taking over reference requests. Do not silently resume parked work or turn local capabilities into standing operational permission.

### Duties and authority

- [ ] Deliver ordinary reminders without treating their text as authorization to execute work.
- [ ] Perform the approved security follow-up as a read-only advisory check against known software inventory, reporting relevant findings and unknown exposure. Do not patch, restart services, or change configuration as part of this duty.
- [ ] Support automatic disk cleanup only within categories approved by the user. No category is approved yet.
- [ ] Permit proactive read-only inspection for other local machine problems and proposals for new duties. Discovery does not authorize a new corrective action.
- [ ] Allow agents to infer useful durable reminders without requiring an explicit user command, and report each addition, as specified in [Reminders](reminders.md).

### Reporting

- [ ] Keep full reports in the dedicated assistant conversation and send a desktop notification for alerts that need the user's attention.
- [ ] Do not broadcast reminder or maintenance alerts to every running project session.

### Interaction

- [ ] Keep the existing terminal interface for the assistant rather than building a new dashboard.
- [ ] Provide access through the agreed Super+A session switcher covering the laptop and agent-server; session-access behavior belongs to the external [remote-agent switcher contract](https://github.com/Osso/remote-agent/blob/main/docs/specs/session-switcher.md).

## How it works

Pi already supports [cross-host direct messages](multi-agent.md#cross-host-messaging) addressed by host and session ID. Permanent contact discovery, launch, and restoration are not yet designed; a new transport or issue-management layer is not assumed.

Implementation architecture is not selected. The current proposal separates a scheduling/check layer from model reasoning so that a persistent process does not require continuous model polling. Wake conditions, execution recovery, model selection, and resource limits still need design decisions.

Proposed cleanup policy includes allowed paths, retention rules, protected exclusions, enforcement by the cleanup operation, and removed-data/space-recovery reports. These details need approval when defining the first category. Storing duty state and execution results in control-DB records, rather than relying only on the conversation, is also a proposal pending a persistence decision.

## Implementation inventory

No integrated machine-assistant service exists for this design.

## Tests asserting this spec

None. All requirements remain unchecked.

## Known gaps (current cycle)

- [ ] Decide scheduling and wake behavior, including the proactive inspection cadence; the user explicitly deferred that cadence.
- [ ] Select the model and resource budget.
- [ ] Define and approve the first cleanup category and its concrete policy. No cleanup category is approved yet.
- [ ] Define desktop-alert repetition and routine-report behavior. Quiet routine reports and alerts only for new or changed findings are proposals, not accepted requirements.
- [ ] Decide implementation and service supervision before resuming the paused assistant implementation. The terminal interface and dual-host session switcher are selected; the assistant service itself is not implemented.
- [ ] Define and verify handover of the two reference roles before replacing them. Their read-only role summaries have been obtained; neither session has been stopped or transferred. Concise role instructions and resource pointers, rather than wholesale transcript merging, are the current proposal.
- [ ] Define how server sessions learn the permanent laptop address and how the same assistant identity is restored after restart; reuse existing host/session mailbox routing where sufficient.

## Out of scope

- Unrestricted machine modification: authority is limited to approved duties and cleanup categories.
- Automatic security remediation: the approved security duty is read-only.
- Reading all project transcripts or inheriting their active goals merely because the assistant is persistent: no such access requirement was approved.
- Cross-machine reminder synchronization or remote administrative authority: the current design is machine-local.
