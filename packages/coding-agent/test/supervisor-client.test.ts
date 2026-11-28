import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	claimNextSupervisorRequest,
	completeSupervisorRequest,
	readSupervisorRequest,
	registerRuntimeMailboxListener,
	type SupervisorRequest,
	type SupervisorResponse,
	takeRuntimeMailboxMessagesForDelivery,
} from "../src/core/session-control-db.ts";
import { requestSupervisorDecision } from "../src/supervisor/client.ts";
import { SupervisorNotRunningError } from "../src/supervisor/ensure-running.ts";
import { ingestSupervisorRequestMail, type SupervisorAddress, sendSupervisorReply } from "../src/supervisor/mail.ts";
import { pairHostRelays } from "./host-relay-pair.ts";

const ASKER = { sessionId: "asker-session", agentId: null };
const SUPERVISOR: SupervisorAddress = { sessionId: "supervisor-session" };
const REMOTE_SUPERVISOR: SupervisorAddress = { sessionId: "supervisor-session", host: "supervisor-test-host" };

function request(controlDbPath: string, overrides: Partial<Parameters<typeof requestSupervisorDecision>[0]> = {}) {
	return {
		controlDbPath,
		kind: "approval_review" as const,
		payload: { toolName: "read" },
		projectId: "pi",
		senderSessionId: ASKER.sessionId,
		timeoutMs: 5_000,
		...overrides,
	};
}

async function claim(controlDbPath: string): Promise<SupervisorRequest> {
	let claimed: SupervisorRequest | undefined;
	await vi.waitFor(() => {
		claimed = claimNextSupervisorRequest(controlDbPath, "runtime");
		expect(claimed).toBeDefined();
	});
	return claimed as SupervisorRequest;
}

/** Completes a claimed request and replies the way the Supervisor does. */
function answer(controlDbPath: string, claimed: SupervisorRequest, response: SupervisorResponse): void {
	completeSupervisorRequest(controlDbPath, claimed.id, "runtime", response);
	const replyTo = readSupervisorRequest(controlDbPath, claimed.id)?.replyTo;
	if (!replyTo) throw new Error("request has no reply route");
	sendSupervisorReply(controlDbPath, SUPERVISOR.sessionId, replyTo, { requestKind: claimed.kind, response });
}

describe("Supervisor client", () => {
	let tempDir: string;
	let askerDb: string;
	let supervisorDb: string;
	const stops: Array<() => void> = [];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-supervisor-client-"));
		askerDb = join(tempDir, "asker.sqlite");
		supervisorDb = join(tempDir, "supervisor.sqlite");
		registerRuntimeMailboxListener(askerDb, ASKER, process.pid);
	});

	afterEach(async () => {
		for (const stop of stops.splice(0)) stop();
		await new Promise((resolve) => setTimeout(resolve, 20));
		rmSync(tempDir, { force: true, recursive: true });
	});

	/** Joins the two control DBs with the real relay protocol, as a pi server hub link does between hosts. */
	function connectHosts(): void {
		stops.push(
			pairHostRelays(
				{ controlDbPath: askerDb, host: "asker-test-host" },
				{ controlDbPath: supervisorDb, host: "supervisor-test-host" },
			),
		);
	}

	it("returns the reply the local Supervisor sends to the asking session's mailbox", async () => {
		const ensureRunning = vi.fn(async () => SUPERVISOR);
		const decision = requestSupervisorDecision(request(askerDb), { ensureRunning });

		answer(askerDb, await claim(askerDb), { kind: "approve", reason: "bounded" });

		await expect(decision).resolves.toEqual({ kind: "approve", reason: "bounded" });
		expect(ensureRunning).toHaveBeenCalledWith({ controlDbPath: askerDb });
	});

	it("returns a typed error without posting when no Supervisor is configured", async () => {
		const ensureRunning = async (): Promise<SupervisorAddress> => {
			throw new Error("no Supervisor session is configured; set supervisor.sessionId");
		};
		await expect(requestSupervisorDecision(request(askerDb), { ensureRunning })).resolves.toEqual({
			kind: "error",
			reason: "Supervisor startup failed: no Supervisor session is configured; set supervisor.sessionId",
		});
		expect(readSupervisorRequest(askerDb, 1)).toBeUndefined();
	});

	it("returns the answer of a local Supervisor that restarts after the request", async () => {
		const ensureRunning = async (): Promise<SupervisorAddress> => {
			throw new SupervisorNotRunningError(SUPERVISOR);
		};
		const decision = requestSupervisorDecision(request(askerDb), { ensureRunning, restartGraceMs: 2_000 });

		answer(askerDb, await claim(askerDb), { kind: "approve", reason: "after restart" });

		await expect(decision).resolves.toEqual({ kind: "approve", reason: "after restart" });
	});

	it("fails when a local Supervisor that is not running does not answer within the restart grace", async () => {
		const ensureRunning = async (): Promise<SupervisorAddress> => {
			throw new SupervisorNotRunningError(SUPERVISOR);
		};
		await expect(requestSupervisorDecision(request(askerDb), { ensureRunning, restartGraceMs: 50 })).resolves.toEqual(
			{
				kind: "error",
				reason: "Supervisor startup failed: the Supervisor session supervisor-session is not running",
			},
		);
		expect(readSupervisorRequest(askerDb, 1)).toMatchObject({ status: "pending" });
	});

	it("cancels the queued request when its signal aborts", async () => {
		const controller = new AbortController();
		const decision = requestSupervisorDecision(request(askerDb, { signal: controller.signal }), {
			ensureRunning: async () => SUPERVISOR,
		});

		await vi.waitFor(() => expect(readSupervisorRequest(askerDb, 1)).toBeDefined());
		controller.abort();

		await expect(decision).resolves.toEqual({ kind: "error", reason: "Supervisor request cancelled" });
		expect(readSupervisorRequest(askerDb, 1)).toMatchObject({
			status: "cancelled",
			response: { kind: "error", reason: "Supervisor request cancelled" },
		});
	});

	it("returns error when no reply arrives before the deadline", async () => {
		await expect(
			requestSupervisorDecision(request(askerDb, { timeoutMs: 50 }), { ensureRunning: async () => SUPERVISOR }),
		).resolves.toEqual({ kind: "error", reason: "Supervisor request timed out" });
	});

	it("sends a request to a Supervisor on another host and receives its reply through the relay", async () => {
		registerRuntimeMailboxListener(
			supervisorDb,
			{ sessionId: REMOTE_SUPERVISOR.sessionId, agentId: null },
			process.pid,
		);
		connectHosts();
		const decision = requestSupervisorDecision(request(askerDb, { kind: "supervisor_advisory" }), {
			ensureRunning: async () => REMOTE_SUPERVISOR,
		});

		const recipient = { sessionId: REMOTE_SUPERVISOR.sessionId, agentId: null };
		await vi.waitFor(() => {
			const mail = takeRuntimeMailboxMessagesForDelivery(supervisorDb, recipient, () => true);
			expect(mail.map((message) => ingestSupervisorRequestMail(supervisorDb, message))).toEqual([true]);
		});
		const claimed = await claim(supervisorDb);
		expect(claimed).toMatchObject({
			kind: "supervisor_advisory",
			senderSessionId: ASKER.sessionId,
			replyTo: { host: "asker-test-host", sessionId: ASKER.sessionId, agentId: null },
		});
		answer(supervisorDb, claimed, { kind: "advisory", answer: "Use the spec." });

		await expect(decision).resolves.toEqual({ kind: "advisory", answer: "Use the spec." });
	});

	it("returns the answer of a remote Supervisor that restarts after the relay reports it not running", async () => {
		connectHosts();
		const decision = requestSupervisorDecision(request(askerDb, { kind: "supervisor_advisory" }), {
			ensureRunning: async () => REMOTE_SUPERVISOR,
			restartGraceMs: 5_000,
		});
		const recipient = { sessionId: REMOTE_SUPERVISOR.sessionId, agentId: null };
		// The relays (20 ms polls) deliver the not-running notice while the Supervisor has no listener.
		await new Promise((resolve) => setTimeout(resolve, 500));

		registerRuntimeMailboxListener(supervisorDb, recipient, process.pid);
		await vi.waitFor(() => {
			const mail = takeRuntimeMailboxMessagesForDelivery(supervisorDb, recipient, () => true);
			expect(mail.map((message) => ingestSupervisorRequestMail(supervisorDb, message))).toEqual([true]);
		});
		answer(supervisorDb, await claim(supervisorDb), { kind: "advisory", answer: "Back." });

		await expect(decision).resolves.toEqual({ kind: "advisory", answer: "Back." });
	});

	it("fails when the relay reports that the remote Supervisor session is not running", async () => {
		connectHosts();
		await expect(
			requestSupervisorDecision(request(askerDb), {
				ensureRunning: async () => REMOTE_SUPERVISOR,
				restartGraceMs: 50,
			}),
		).resolves.toMatchObject({
			kind: "error",
			reason: expect.stringContaining("The Supervisor session is not running: Not delivered yet"),
		});
	});
});
