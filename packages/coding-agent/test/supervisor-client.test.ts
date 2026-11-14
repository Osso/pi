import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runHostRelay } from "../src/core/host-relay.ts";
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
import { ingestSupervisorRequestMail, type SupervisorAddress, sendSupervisorReply } from "../src/supervisor/mail.ts";

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

	/** Joins the two control DBs with the real relay protocol, as SSH does between hosts. */
	function connectHosts(): void {
		const toSupervisor = new PassThrough();
		const toAsker = new PassThrough();
		const controller = new AbortController();
		stops.push(() => controller.abort());
		const common = { pollMs: 20, signal: controller.signal };
		void runHostRelay({
			...common,
			controlDbPath: askerDb,
			host: "asker-test-host",
			input: toAsker,
			output: toSupervisor,
		});
		void runHostRelay({
			...common,
			controlDbPath: supervisorDb,
			host: REMOTE_SUPERVISOR.host,
			input: toSupervisor,
			output: toAsker,
		});
	}

	it("returns the reply the local Supervisor sends to the asking session's mailbox", async () => {
		const ensureRunning = vi.fn(async () => SUPERVISOR);
		const decision = requestSupervisorDecision(request(askerDb), { ensureRunning });

		answer(askerDb, await claim(askerDb), { kind: "approve", reason: "bounded" });

		await expect(decision).resolves.toEqual({ kind: "approve", reason: "bounded" });
		expect(ensureRunning).toHaveBeenCalledWith({ controlDbPath: askerDb });
	});

	it("returns a typed error without posting when Supervisor startup fails", async () => {
		const ensureRunning = async (): Promise<SupervisorAddress> => {
			throw new Error("the Supervisor session supervisor-session is not running");
		};
		await expect(requestSupervisorDecision(request(askerDb), { ensureRunning })).resolves.toEqual({
			kind: "error",
			reason: "Supervisor startup failed: the Supervisor session supervisor-session is not running",
		});
		expect(readSupervisorRequest(askerDb, 1)).toBeUndefined();
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

	it("fails when the relay reports that the remote Supervisor session is not running", async () => {
		connectHosts();
		await expect(
			requestSupervisorDecision(request(askerDb), { ensureRunning: async () => REMOTE_SUPERVISOR }),
		).resolves.toMatchObject({
			kind: "error",
			reason: expect.stringContaining("The Supervisor session is not running: Not delivered yet"),
		});
	});
});
