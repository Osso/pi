import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { createSupervisorInstructionEvaluator } from "../../src/supervisor/request-evaluation.ts";

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
	const registry = ModelRegistry.create(AuthStorage.create(join(tempDir, "auth.json")), join(tempDir, "models.json"));
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
		const evaluate = createSupervisorInstructionEvaluator(
			ModelRegistry.create(AuthStorage.create(join(tempDir, "auth.json")), join(tempDir, "models.json")),
			tempDir,
			tempDir,
		);
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
