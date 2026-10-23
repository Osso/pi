import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupervisorRequest } from "../src/core/session-control-db.ts";
import { DEFAULT_SUPERVISOR_POLL_INTERVAL_MS, requestSupervisorDecision } from "../src/supervisor/client.ts";
import { createSupervisorInstructionEvaluator, runSupervisorService } from "../src/supervisor/main.ts";

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
		authenticatedProviders: new Set<string>(),
		streamResults: [] as Array<{ provider: string; stopReason: string; errorMessage?: string; text?: string }>,
		streamedProviders: [] as string[],
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

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return {
		...actual,
		streamSimple: (model: { provider: string }) => ({
			result: async () => {
				mocks.streamedProviders.push(model.provider);
				const result = mocks.streamResults.find((candidate) => candidate.provider === model.provider);
				if (!result) throw new Error(`Unexpected Supervisor request to ${model.provider}`);
				return {
					content: result.text ? [{ text: result.text, type: "text" }] : [],
					errorMessage: result.errorMessage,
					provider: model.provider,
					stopReason: result.stopReason,
				};
			},
		}),
	};
});

vi.mock("../src/core/model-registry.ts", () => ({
	ModelRegistry: {
		create: () => ({
			find: (provider: string, id: string) =>
				(provider.startsWith("openai-codex") && id === "gpt-6.1-sol") ||
				(provider === "openrouter" && id === "deepseek/deepseek-v4.1-flash-1017")
					? { baseUrl: "https://example.test", id, provider }
					: undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
			hasConfiguredAuth: (model: { provider: string }) => mocks.authenticatedProviders.has(model.provider),
		}),
	},
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
		mocks.authenticatedProviders = new Set(["openai-codex"]);
		mocks.streamResults = [];
		mocks.streamedProviders = [];
		mocks.createAgentSession.mockClear();
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

	it("starts the resident session on the first authenticated Codex provider", async () => {
		mocks.authenticatedProviders = new Set(["openai-codex-gc", "openai-codex-team"]);
		mocks.claimNextSupervisorRequest.mockReturnValue(undefined);
		const service = runSupervisorService();
		try {
			await flushServiceStartup();
			expect(mocks.createAgentSession).toHaveBeenCalledWith(
				expect.objectContaining({
					model: expect.objectContaining({ id: "gpt-6.1-sol", provider: "openai-codex-gc" }),
				}),
			);
		} finally {
			await stopService(service);
		}
	});

	it("fails startup when no Codex provider is authenticated", () => {
		mocks.authenticatedProviders = new Set();
		expect(() => createSupervisorInstructionEvaluator(mocks.agentDir)).toThrow(
			"Pi Supervisor requires gpt-6.1-sol on an authenticated provider: openai-codex, openai-codex-gc, openai-codex-team",
		);
	});

	it("uses the configured supervisorModel for the resident session and instruction review", async () => {
		mocks.authenticatedProviders = new Set(["openai-codex", "openrouter"]);
		writeFileSync(
			join(mocks.agentDir, "settings.json"),
			JSON.stringify({ supervisorModel: "openrouter/deepseek/deepseek-v4.1-flash-1017" }),
		);
		mocks.streamResults = [{ provider: "openrouter", stopReason: "stop", text: '{"decision":"accept"}' }];

		const evaluate = createSupervisorInstructionEvaluator(mocks.agentDir);
		await expect(evaluate("continue", new AbortController().signal)).resolves.toBe('{"decision":"accept"}');
		expect(mocks.streamedProviders).toEqual(["openrouter"]);

		mocks.claimNextSupervisorRequest.mockReturnValue(undefined);
		const service = runSupervisorService();
		try {
			await flushServiceStartup();
			expect(mocks.createAgentSession).toHaveBeenCalledWith(
				expect.objectContaining({
					model: expect.objectContaining({ id: "deepseek/deepseek-v4.1-flash-1017", provider: "openrouter" }),
				}),
			);
		} finally {
			await stopService(service);
		}
	});

	it("fails startup when the configured supervisorModel is not authenticated", () => {
		mocks.authenticatedProviders = new Set(["openai-codex"]);
		writeFileSync(
			join(mocks.agentDir, "settings.json"),
			JSON.stringify({ supervisorModel: "openrouter/deepseek/deepseek-v4.1-flash-1017" }),
		);
		expect(() => createSupervisorInstructionEvaluator(mocks.agentDir)).toThrow(
			'Pi Supervisor supervisorModel "openrouter/deepseek/deepseek-v4.1-flash-1017" is not an authenticated provider/modelId',
		);
	});

	it("falls back to the next authenticated Codex provider when instruction review exhausts quota", async () => {
		mocks.authenticatedProviders = new Set(["openai-codex-gc", "openai-codex-team"]);
		mocks.streamResults = [
			{ provider: "openai-codex-gc", stopReason: "error", errorMessage: "You have hit your usage limit." },
			{ provider: "openai-codex-team", stopReason: "stop", text: '{"decision":"accept"}' },
		];
		const evaluate = createSupervisorInstructionEvaluator(mocks.agentDir);

		await expect(evaluate("continue", new AbortController().signal)).resolves.toBe('{"decision":"accept"}');
		expect(mocks.streamedProviders).toEqual(["openai-codex-gc", "openai-codex-team"]);
	});

	it("does not fall back for non-quota instruction review errors", async () => {
		mocks.authenticatedProviders = new Set(["openai-codex", "openai-codex-gc"]);
		mocks.streamResults = [{ provider: "openai-codex", stopReason: "error", errorMessage: "500 internal error" }];
		const evaluate = createSupervisorInstructionEvaluator(mocks.agentDir);

		await expect(evaluate("continue", new AbortController().signal)).resolves.toBeUndefined();
		expect(mocks.streamedProviders).toEqual(["openai-codex"]);
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
