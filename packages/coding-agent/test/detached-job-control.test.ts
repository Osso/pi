import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	claimDetachedJobControlCommands,
	claimDetachedJobRuntimeCommands,
	enqueueDetachedJobStatusRequest,
} from "../src/core/detached-job-control.ts";
import type { DetachedJobLeaseIdentity } from "../src/core/detached-job-runner.ts";
import {
	enqueueRuntimeMailboxMessage,
	listRuntimeMailboxMessages,
	upsertMultiAgentMailboxMessage,
} from "../src/core/session-control-db.ts";

const temporaryDirectories: string[] = [];
const identity: DetachedJobLeaseIdentity = {
	expectedRevision: 3,
	fencingEpoch: 7,
	jobId: "agent_1",
	leaseId: "lease-1",
	outputLabel: "Bash output",
	runtimeIncarnation: "runner-1",
};

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("detached job runtime mailbox control", () => {
	it("accepts a newer cancellation revision under the exact lease and consumes the command", () => {
		const fixture = createFixture();
		const cancellingIdentity = { ...identity, expectedRevision: identity.expectedRevision + 1 };
		enqueueControl(fixture, "message_1", {
			command: "cancel",
			identity: cancellingIdentity,
			reason: "user requested",
		});

		expect(claimDetachedJobControlCommands(fixture.controlDbPath, fixture.recipient, identity)).toEqual([
			{ command: "cancel", identity: cancellingIdentity, reason: "user requested", transportId: 1 },
		]);
		expect(listRuntimeMailboxMessages(fixture.controlDbPath)).toMatchObject([{ id: 1, status: "delivered" }]);
	});

	it("accepts a status request only at the exact current revision", () => {
		const fixture = createFixture();
		enqueueDetachedJobStatusRequest({
			controlDbPath: fixture.controlDbPath,
			identity,
			requesterAddress: { agentId: null, sessionId: "supervisor-1" },
			requestId: "status-1",
			runnerAddress: fixture.recipient,
			sessionPath: fixture.sessionPath,
		});

		expect(claimDetachedJobRuntimeCommands(fixture.controlDbPath, fixture.recipient, identity)).toEqual([
			{
				command: "status",
				identity,
				replyTo: { agentId: null, sessionId: "supervisor-1" },
				requestId: "status-1",
				transportId: 1,
			},
		]);
	});

	it("accepts a bridge response only at the exact current revision", () => {
		const fixture = createFixture();
		enqueueControl(fixture, "message_1", {
			command: "respond",
			identity,
			requestId: "request-1",
			result: { value: 42 },
		});

		expect(claimDetachedJobRuntimeCommands(fixture.controlDbPath, fixture.recipient, identity)).toEqual([
			{
				command: "respond",
				identity,
				requestId: "request-1",
				result: { value: 42 },
				transportId: 1,
			},
		]);
	});

	it("rejects a bridge response from a different revision", () => {
		const fixture = createFixture();
		enqueueControl(fixture, "message_1", {
			command: "respond",
			identity: { ...identity, expectedRevision: identity.expectedRevision + 1 },
			requestId: "request-1",
		});

		expect(claimDetachedJobRuntimeCommands(fixture.controlDbPath, fixture.recipient, identity)).toEqual([]);
		expect(listRuntimeMailboxMessages(fixture.controlDbPath)).toMatchObject([
			{ error: "Detached job control identity mismatch", id: 1, status: "failed" },
		]);
	});

	it("rejects a skipped cancellation revision without returning a payload command", () => {
		const fixture = createFixture();
		enqueueControl(fixture, "message_1", {
			command: "cancel",
			identity: { ...identity, expectedRevision: identity.expectedRevision + 2 },
		});

		expect(claimDetachedJobControlCommands(fixture.controlDbPath, fixture.recipient, identity)).toEqual([]);
		expect(listRuntimeMailboxMessages(fixture.controlDbPath)).toMatchObject([
			{ error: "Detached job control identity mismatch", id: 1, status: "failed" },
		]);
	});

	it("rejects a stale fencing epoch without returning a payload command", () => {
		const fixture = createFixture();
		enqueueControl(fixture, "message_1", {
			command: "cancel",
			identity: { ...identity, fencingEpoch: identity.fencingEpoch - 1 },
		});

		expect(claimDetachedJobControlCommands(fixture.controlDbPath, fixture.recipient, identity)).toEqual([]);
		expect(listRuntimeMailboxMessages(fixture.controlDbPath)).toMatchObject([
			{ error: "Detached job control identity mismatch", id: 1, status: "failed" },
		]);
	});
});

function createFixture() {
	const directory = mkdtempSync(join(tmpdir(), "pi-detached-control-"));
	temporaryDirectories.push(directory);
	return {
		controlDbPath: join(directory, "control.sqlite"),
		recipient: { agentId: identity.jobId, sessionId: "supervisor-1" },
		sessionPath: join(directory, "session.jsonl"),
	};
}

function enqueueControl(
	fixture: ReturnType<typeof createFixture>,
	messageId: string,
	body: Record<string, unknown>,
): void {
	upsertMultiAgentMailboxMessage(fixture.controlDbPath, fixture.sessionPath, messageId, {
		body: JSON.stringify(body),
		fromAgentId: "main",
		id: messageId,
		kind: "system",
		status: "pending",
		toAgentId: identity.jobId,
	});
	enqueueRuntimeMailboxMessage(fixture.controlDbPath, {
		kind: "system",
		recipient: fixture.recipient,
		sender: { agentId: null, sessionId: "supervisor-1" },
		storeRef: { messageId, sessionPath: fixture.sessionPath },
	});
}
