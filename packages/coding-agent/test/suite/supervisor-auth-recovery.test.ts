import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, ENV_STATE_DIR } from "../../src/config.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { probeResidentConsole } from "../../src/core/resident-console-transport.ts";
import { readProcessIdentity } from "../../src/core/runtime-process.ts";
import {
	claimNextSupervisorRequest,
	getControlDbPath,
	postSupervisorRequest,
	readSupervisorRequest,
} from "../../src/core/session-control-db.ts";
import { type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import { createSupervisorInstructionEvaluator, processSupervisorRequest } from "../../src/supervisor/main.ts";
import { notifySupervisorRequest } from "../../src/supervisor/request-wake.ts";

const PROVIDER = "openai-codex-gc";
const MODEL = "gpt-6.1-sol";
const STALE_KEY = "stale-unexpired-access";
const FRESH_KEY = "fresh-unexpired-access";

function replaceOAuthCredentials(agentDir: string, access: string): void {
	// A distinct storage instance represents /login in another process; no expiry-driven refresh.
	AuthStorage.create(join(agentDir, "auth.json")).set(PROVIDER, {
		type: "oauth",
		access,
		refresh: "inert-refresh-never-used",
		expires: Date.now() + 3_600_000,
	});
}

function writeModelConfig(agentDir: string): void {
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				[PROVIDER]: {
					api: "supervisor-auth-faux",
					baseUrl: "http://localhost:0",
					models: [{ id: MODEL, reasoning: true }],
				},
			},
		}),
	);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ supervisorModel: `${PROVIDER}/${MODEL}` }));
}

interface ProviderReport {
	pid: number;
	sessionId: string;
	apiKey: string;
	provider: string;
	modelId: string;
	messages: unknown[];
}

describe("resident Supervisor external credential recovery", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-supervisor-auth-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("reloads unexpired OAuth credentials at the shared request boundary", async () => {
		writeModelConfig(tempDir);
		replaceOAuthCredentials(tempDir, STALE_KEY);
		const registry = ModelRegistry.create(
			AuthStorage.create(join(tempDir, "auth.json")),
			join(tempDir, "models.json"),
		);
		const model = registry.find(PROVIDER, MODEL);
		if (!model) throw new Error("Missing Codex test model");
		expect(await registry.getApiKeyAndHeaders(model)).toMatchObject({
			ok: true,
			apiKey: STALE_KEY,
		});

		replaceOAuthCredentials(tempDir, FRESH_KEY);

		expect(await registry.getApiKeyAndHeaders(model)).toMatchObject({
			ok: true,
			apiKey: FRESH_KEY,
		});
		expect(registry.find(PROVIDER, MODEL)).toBe(model);
	});

	it("reloads provider environment and headers while preserving a runtime key override", async () => {
		const storage = AuthStorage.create(join(tempDir, "auth.json"));
		storage.set(PROVIDER, {
			type: "api_key",
			key: "$TOKEN",
			env: { TOKEN: "old", TENANT: "old-tenant" },
		});
		writeFileSync(
			join(tempDir, "models.json"),
			JSON.stringify({
				providers: {
					[PROVIDER]: { api: "supervisor-auth-faux", models: [{ id: MODEL }], headers: { "X-Tenant": "$TENANT" } },
				},
			}),
		);
		const registry = ModelRegistry.create(storage, join(tempDir, "models.json"));
		const model = registry.find(PROVIDER, MODEL);
		if (!model) throw new Error("Missing Codex test model");
		storage.setRuntimeApiKey(PROVIDER, "runtime-override");
		expect(await registry.getApiKeyAndHeaders(model)).toMatchObject({
			ok: true,
			apiKey: "runtime-override",
			headers: { "X-Tenant": "old-tenant" },
		});
		AuthStorage.create(join(tempDir, "auth.json")).set(PROVIDER, {
			type: "api_key",
			key: "$TOKEN",
			env: { TOKEN: "new", TENANT: "new-tenant" },
		});

		expect(await registry.getApiKeyAndHeaders(model)).toMatchObject({
			ok: true,
			apiKey: "runtime-override",
			env: { TOKEN: "new", TENANT: "new-tenant" },
			headers: { "X-Tenant": "new-tenant" },
		});
		storage.removeRuntimeApiKey(PROVIDER);
		expect(await registry.getApiKeyAndHeaders(model)).toMatchObject({
			ok: true,
			apiKey: "new",
		});
	});

	it("recovers the same instruction evaluator after external re-login without auth fallback", async () => {
		writeModelConfig(tempDir);
		replaceOAuthCredentials(tempDir, STALE_KEY);
		const faux = registerFauxProvider({
			api: "supervisor-auth-faux",
			provider: PROVIDER,
			models: [{ id: MODEL }],
		});
		const requests: Array<{
			apiKey: string | undefined;
			provider: string;
			messages: unknown[];
		}> = [];
		const respond: Parameters<typeof faux.setResponses>[0][number] = (context, options, _state, model) => {
			faux.appendResponses([respond]);
			requests.push({
				apiKey: options?.apiKey,
				provider: model.provider,
				messages: context.messages,
			});
			return options?.apiKey === FRESH_KEY
				? fauxAssistantMessage("ACCEPT")
				: fauxAssistantMessage([], {
						stopReason: "error",
						errorMessage: "401: invalid access token",
					});
		};
		faux.setResponses([respond]);
		try {
			const evaluate = createSupervisorInstructionEvaluator(tempDir);
			expect(await evaluate("First raw instruction", new AbortController().signal)).toBeUndefined();
			replaceOAuthCredentials(tempDir, FRESH_KEY);
			expect(await evaluate("Second raw instruction", new AbortController().signal)).toBe("ACCEPT");
			expect(requests).toEqual([
				{
					apiKey: STALE_KEY,
					provider: PROVIDER,
					messages: [
						{
							role: "user",
							content: "First raw instruction",
							timestamp: expect.any(Number),
						},
					],
				},
				{
					apiKey: FRESH_KEY,
					provider: PROVIDER,
					messages: [
						{
							role: "user",
							content: "Second raw instruction",
							timestamp: expect.any(Number),
						},
					],
				},
			]);
		} finally {
			faux.unregister();
		}
	});

	it("returns the current model error detail rather than an earlier successful response", async () => {
		const controlDbPath = getControlDbPath(tempDir);
		const id = postSupervisorRequest(controlDbPath, {
			deadlineAt: new Date(Date.now() + 10_000).toISOString(),
			kind: "goal_set_review",
			payload: { proposedObjective: "Retain scope" },
			projectId: "pi",
			senderSessionId: "test",
		});
		const request = claimNextSupervisorRequest(controlDbPath, "test-runtime");
		if (!request) throw new Error("Missing claimed test request");
		const sessionManager = SessionManager.create(tempDir, tempDir);
		sessionManager.appendMessage({ role: "user", content: "Earlier request", timestamp: Date.now() });
		sessionManager.appendMessage(
			fauxAssistantMessage('{"kind":"set","objective":"Old scope","reason":"Old review"}'),
		);
		await processSupervisorRequest(controlDbPath, request, {
			abort: async () => {},
			prompt: async () => {
				sessionManager.appendMessage(
					fauxAssistantMessage([], {
						stopReason: "error",
						errorMessage: "WebSocket 401: invalid access token",
					}),
				);
			},
			sessionManager,
		});
		expect(readSupervisorRequest(controlDbPath, id)?.response).toEqual({
			kind: "error",
			reason: "Supervisor model request ended with error: WebSocket 401: invalid access token",
		});
	});

	it("recovers the same resident PID and transcript after failed auth and external credential replacement", async () => {
		const agentDir = join(tempDir, "agent");
		const stateDir = join(tempDir, "state");
		const kbDir = join(tempDir, "kb");
		const homeDir = join(tempDir, "home");
		for (const dir of [agentDir, stateDir, kbDir, homeDir]) mkdirSync(dir);
		writeModelConfig(agentDir);
		replaceOAuthCredentials(agentDir, STALE_KEY);
		const reportPath = join(tempDir, "requests.jsonl");
		const controlDbPath = getControlDbPath(stateDir);
		const child = spawn(
			process.execPath,
			["--experimental-strip-types", join(import.meta.dirname, "fixtures", "supervisor-auth-resident.ts")],
			{
				cwd: kbDir,
				env: {
					PATH: process.env.PATH,
					HOME: homeDir,
					XDG_CONFIG_HOME: join(homeDir, "config"),
					XDG_CACHE_HOME: join(homeDir, "cache"),
					[ENV_AGENT_DIR]: agentDir,
					[ENV_STATE_DIR]: stateDir,
					PI_KB_DIR: kbDir,
					PI_OFFLINE: "1",
					PI_SUPERVISOR_AUTH_REPORT: reportPath,
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			output += String(chunk);
		});
		const exited = once(child, "exit");
		const probe = () =>
			probeResidentConsole<SessionEntry>({
				socketPath: `${controlDbPath}.supervisor-console.sock`,
				service: "supervisor",
			});
		const review = async (objective: string) => {
			const id = postSupervisorRequest(controlDbPath, {
				deadlineAt: new Date(Date.now() + 15_000).toISOString(),
				kind: "goal_set_review",
				payload: { proposedObjective: objective, userMessages: [objective] },
				projectId: "pi",
				senderSessionId: "auth-regression",
			});
			notifySupervisorRequest(controlDbPath);
			await vi.waitFor(() => expect(readSupervisorRequest(controlDbPath, id)?.status).toBe("completed"), {
				timeout: 15_000,
				interval: 20,
			});
			return readSupervisorRequest(controlDbPath, id)?.response;
		};
		try {
			await vi.waitFor(async () => expect((await probe()).identity?.pid).toBe(child.pid), {
				timeout: 15_000,
				interval: 20,
			});
			const before = await probe();
			const identity = child.pid ? readProcessIdentity(child.pid) : undefined;
			expect(identity).toBeDefined();
			const failure = await review("Original full-scope marker");
			expect(failure).toMatchObject({ kind: "error" });
			const failedBranch = (await probe()).branch;
			expect(JSON.stringify(failedBranch)).toContain("Original full-scope marker");
			replaceOAuthCredentials(agentDir, FRESH_KEY);

			expect(await review("Recovery marker")).toMatchObject({
				kind: "set",
				objective: "Preserve the full objective",
			});
			expect(await review("Follow-up marker")).toMatchObject({ kind: "set" });
			const after = await probe();
			expect(after.identity).toEqual(before.identity);
			expect(after.generation).toBe(before.generation);
			expect(after.sessionId).toBe(before.sessionId);
			expect(child.pid && readProcessIdentity(child.pid)).toEqual(identity);
			expect(after.branch.slice(0, failedBranch.length)).toEqual(failedBranch);
			const reports = readFileSync(reportPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as ProviderReport);
			expect(reports.map(({ apiKey }) => apiKey)).toEqual([STALE_KEY, FRESH_KEY, FRESH_KEY]);
			for (const report of reports) {
				expect(report).toMatchObject({
					pid: child.pid,
					sessionId: before.sessionId,
					provider: PROVIDER,
					modelId: MODEL,
				});
			}
			expect(JSON.stringify(reports[1].messages)).toContain("Original full-scope marker");
			expect(JSON.stringify(reports[2].messages)).toContain("Preserve the full objective");
			expect(failure).toMatchObject({
				reason: "Supervisor model request ended with error: WebSocket 401: invalid access token",
			});
		} finally {
			child.kill("SIGTERM");
			const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
			try {
				await exited;
			} finally {
				clearTimeout(killTimer);
			}
			writeFileSync("/tmp/pi-supervisor-auth-resident.log", output);
		}
	}, 30_000);
});
