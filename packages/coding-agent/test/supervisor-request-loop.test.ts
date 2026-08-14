import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupervisorRequest } from "../src/core/session-control-db.ts";
import { DEFAULT_SUPERVISOR_POLL_INTERVAL_MS, requestSupervisorDecision } from "../src/supervisor/client.ts";
import { runSupervisorService } from "../src/supervisor/main.ts";

const mocks = vi.hoisted(() => {
	const sessionEntries: Array<Record<string, unknown>> = [];
	const sessionManager = {
		getBranch: vi.fn(() => sessionEntries),
		getLeafId: vi.fn(() => null),
		getSessionFile: vi.fn(() => undefined),
		setMetadataControlDbPath: vi.fn(),
	};
	const session = {
		abort: vi.fn(async () => {}),
		prompt: vi.fn(async () => {
			sessionEntries.push({
				id: "assistant-response",
				message: {
					content: [{ text: '{"kind":"approve","reason":"socket wake"}', type: "text" }],
					role: "assistant",
					stopReason: "stop",
				},
				type: "message",
			});
		}),
		sessionManager,
	};
	return {
		agentDir: "",
		archiveSession: vi.fn(),
		claimNextSupervisorRequest: vi.fn<() => SupervisorRequest | undefined>(),
		completeSupervisorRequest: vi.fn(),
		createAgentSession: vi.fn(async () => ({ session })),
		recoverSupervisorRequests: vi.fn(),
		session,
		sessionEntries,
		sessionManager,
	};
});

vi.mock("../../extensions/openai-remote-compact/src/index.ts", () => ({ default: vi.fn() }));

vi.mock("../src/config.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/config.ts")>();
	return { ...actual, getAgentDir: () => mocks.agentDir };
});

vi.mock("../src/core/auth-storage.ts", () => ({
	AuthStorage: { create: vi.fn(() => ({})) },
}));

vi.mock("../src/core/model-registry.ts", () => ({
	ModelRegistry: { create: vi.fn(() => ({ find: vi.fn(() => ({ id: "gpt-5.6-sol" })) })) },
}));

vi.mock("../src/core/resource-loader.ts", () => ({
	DefaultResourceLoader: class {
		async reload(): Promise<void> {}
		getExtensions(): { errors: []; extensions: []; runtime: Record<string, never> } {
			return { errors: [], extensions: [], runtime: {} };
		}
	},
}));

vi.mock("../src/core/sdk.ts", () => ({ createAgentSession: mocks.createAgentSession }));

vi.mock("../src/core/session-control-db.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/session-control-db.ts")>();
	return {
		...actual,
		archiveSession: mocks.archiveSession,
		claimNextSupervisorRequest: mocks.claimNextSupervisorRequest,
		completeSupervisorRequest: mocks.completeSupervisorRequest,
		getControlDbPath: vi.fn(() => join(mocks.agentDir, "control.sqlite")),
		recoverSupervisorRequests: mocks.recoverSupervisorRequests,
	};
});

vi.mock("../src/core/session-manager.ts", () => ({
	SessionManager: {
		create: vi.fn(() => mocks.sessionManager),
		open: vi.fn(() => mocks.sessionManager),
	},
}));

let initialSigtermListeners = new Set(process.listeners("SIGTERM"));

function pendingApprovalRequest(): SupervisorRequest {
	return {
		claimToken: "claim-token",
		claimedAt: "2026-07-25T22:00:00.000Z",
		createdAt: "2026-07-25T22:00:00.000Z",
		deadlineAt: new Date(Date.now() + 30_000).toISOString(),
		id: 1,
		kind: "approval_review",
		payload: { toolName: "read" },
		projectId: "pi",
		senderSessionId: "requester",
		status: "claimed",
	};
}

async function flushServiceStartup(): Promise<void> {
	for (let index = 0; index < 50 && mocks.claimNextSupervisorRequest.mock.calls.length === 0; index += 1) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	expect(mocks.claimNextSupervisorRequest).toHaveBeenCalledTimes(1);
}

async function flushSocketEvents(): Promise<void> {
	for (let index = 0; index < 50 && mocks.session.prompt.mock.calls.length === 0; index += 1) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

async function stopService(service: Promise<void>): Promise<void> {
	await vi.advanceTimersByTimeAsync(DEFAULT_SUPERVISOR_POLL_INTERVAL_MS);
	const stopHandler = process.listeners("SIGTERM").find((handler) => !initialSigtermListeners.has(handler));
	if (!stopHandler) throw new Error("Supervisor service did not install its SIGTERM handler");
	stopHandler("SIGTERM");
	await vi.advanceTimersByTimeAsync(0);
	await service;
}

describe("Supervisor request loop", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["clearTimeout", "setTimeout"] });
		initialSigtermListeners = new Set(process.listeners("SIGTERM"));
		mocks.agentDir = mkdtempSync(join(tmpdir(), "pi-supervisor-request-loop-"));
		mocks.sessionEntries.length = 0;
		mocks.claimNextSupervisorRequest.mockReset();
		mocks.completeSupervisorRequest.mockReset();
		mocks.recoverSupervisorRequests.mockReset();
		mocks.session.abort.mockClear();
		mocks.session.prompt.mockClear();
		mocks.sessionManager.getBranch.mockClear();
		mocks.sessionManager.getLeafId.mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(mocks.agentDir, { force: true, recursive: true });
	});

	it("does not claim repeatedly while no Supervisor request exists", async () => {
		mocks.claimNextSupervisorRequest.mockReturnValue(undefined);
		const service = runSupervisorService();
		try {
			await flushServiceStartup();

			await vi.advanceTimersByTimeAsync(501);

			expect(mocks.claimNextSupervisorRequest).toHaveBeenCalledTimes(1);
		} finally {
			await stopService(service);
		}
	});

	it("claims and delivers one request when the Supervisor socket wakes the idle service", async () => {
		mocks.claimNextSupervisorRequest.mockReturnValueOnce(undefined).mockReturnValueOnce(pendingApprovalRequest());
		const service = runSupervisorService();
		try {
			await flushServiceStartup();

			void requestSupervisorDecision({
				controlDbPath: join(mocks.agentDir, "control.sqlite"),
				kind: "approval_review",
				payload: { toolName: "read" },
				projectId: "pi",
				senderSessionId: "requester",
				timeoutMs: 30_000,
			}).catch(() => {});
			await flushSocketEvents();

			expect(mocks.claimNextSupervisorRequest).toHaveBeenCalledTimes(2);
			expect(mocks.session.prompt).toHaveBeenCalledTimes(1);
		} finally {
			await stopService(service);
		}
	});
});
