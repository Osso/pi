import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Api, getModels, type Model } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { ENV_AGENT_DIR, getUserCacheRoot } from "../src/config.ts";

const NOW = new Date("2026-08-23T12:00:00.000Z");
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function cachedModel(id: string): Model<Api> {
	return {
		id,
		name: `Cached ${id}`,
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: OPENROUTER_BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 4096,
	};
}

function apiModel(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		name: `API ${id}`,
		supported_parameters: ["tools", "reasoning"],
		architecture: { modality: "text+image->text" },
		pricing: {
			prompt: "0.00000125",
			completion: "0.00000425",
			input_cache_read: "0.00000007",
			input_cache_write: "0.0000002",
		},
		context_length: 1048576,
		top_provider: { max_completion_tokens: 32768 },
		...overrides,
	};
}

function responseFor(models: unknown[]): Response {
	return new Response(JSON.stringify({ data: models }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

async function importCatalogModule() {
	return import("../src/core/model-catalog-cache.ts");
}

interface CatalogCacheTestContext {
	cachePath(): string;
	writeCache(fetchedAt: Date, models: Model<Api>[]): void;
	getCacheHome(): string;
}

function useCatalogCache(): CatalogCacheTestContext {
	let cacheHome: string;
	let previousCacheHome: string | undefined;

	beforeEach(() => {
		vi.resetModules();
		cacheHome = mkdtempSync(join(tmpdir(), "pi-model-catalog-cache-"));
		previousCacheHome = process.env.XDG_CACHE_HOME;
		process.env.XDG_CACHE_HOME = cacheHome;
	});

	afterEach(() => {
		if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = previousCacheHome;
		rmSync(cacheHome, { recursive: true, force: true });
	});

	return {
		cachePath: () => join(cacheHome, "pi", "models", "openrouter.json"),
		writeCache(fetchedAt, models) {
			mkdirSync(join(cacheHome, "pi", "models"), { recursive: true });
			writeFileSync(this.cachePath(), JSON.stringify({ fetchedAt: fetchedAt.toISOString(), models }), "utf8");
		},
		getCacheHome: () => cacheHome,
	};
}

describe("OpenRouter model catalog cache configuration", () => {
	const cache = useCatalogCache();

	it("resolves the XDG cache root under pi", () => {
		expect(getUserCacheRoot()).toBe(join(cache.getCacheHome(), "pi"));
	});

	it("falls back to ~/.cache/pi when XDG_CACHE_HOME is unset", () => {
		delete process.env.XDG_CACHE_HOME;

		expect(getUserCacheRoot()).toBe(join(homedir(), ".cache", "pi"));
	});

	it("parses --refresh-models as a built-in flag", () => {
		expect(parseArgs(["--refresh-models"]).refreshModels).toBe(true);
	});
});

describe("OpenRouter model catalog cache refresh", () => {
	const cache = useCatalogCache();

	it("fetches a missing catalog, maps model metadata, and writes the cache", async () => {
		const requests: string[] = [];
		const fetchImpl: typeof fetch = async (input) => {
			requests.push(String(input));
			return responseFor([
				apiModel("fixture/new-tool-model"),
				apiModel("fixture/no-tools", { supported_parameters: [] }),
			]);
		};
		const { ensureModelCatalogFresh, getOpenRouterCatalogModels } = await importCatalogModule();

		const result = await ensureModelCatalogFresh({ fetchImpl, now: () => NOW });

		expect(requests).toEqual(["https://openrouter.ai/api/v1/models"]);
		expect(result.source).toBe("network");
		expect(result.fetchedCount).toBe(1);
		expect(result.cachePath).toBe(cache.cachePath());
		const savedCache = JSON.parse(readFileSync(cache.cachePath(), "utf8")) as {
			fetchedAt: string;
			models: Model<Api>[];
		};
		expect(savedCache.fetchedAt).toBe(NOW.toISOString());
		expect(savedCache.models).toEqual([
			{
				id: "fixture/new-tool-model",
				name: "API fixture/new-tool-model",
				api: "openai-completions",
				provider: "openrouter",
				baseUrl: OPENROUTER_BASE_URL,
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 1.25, output: 4.25, cacheRead: 0.07, cacheWrite: 0.2 },
				contextWindow: 1048576,
				maxTokens: 32768,
			},
		]);
		expect(getOpenRouterCatalogModels().some((model) => model.id === "fixture/new-tool-model")).toBe(true);
	});

	it("refreshes a cache older than seven days", async () => {
		cache.writeCache(new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000), [cachedModel("fixture/stale-cache")]);
		let fetchCount = 0;
		const fetchImpl: typeof fetch = async () => {
			fetchCount++;
			return responseFor([apiModel("fixture/refreshed")]);
		};
		const { ensureModelCatalogFresh } = await importCatalogModule();

		const result = await ensureModelCatalogFresh({ fetchImpl, now: () => NOW });

		expect(fetchCount).toBe(1);
		expect(result.source).toBe("network");
		expect(result.models.some((model) => model.id === "fixture/refreshed")).toBe(true);
		expect(result.models.some((model) => model.id === "fixture/stale-cache")).toBe(false);
	});

	it("keeps bundled metadata on duplicate ids and adds new fetched ids", async () => {
		const bundled = getModels("openrouter") as Model<Api>[];
		const bundledModel = bundled.find((model) => model.id === "anthropic/claude-sonnet-4.6");
		if (!bundledModel) throw new Error("expected bundled OpenRouter model fixture");
		const fetchImpl: typeof fetch = async () =>
			responseFor([
				apiModel(bundledModel.id, {
					context_length: 123,
					pricing: { prompt: "9", completion: "9" },
				}),
				apiModel("fixture/additive-model"),
				apiModel("fixture/additive-model"),
			]);
		const { ensureModelCatalogFresh } = await importCatalogModule();

		const result = await ensureModelCatalogFresh({ fetchImpl, now: () => NOW });

		expect(result.models.find((model) => model.id === bundledModel.id)).toEqual(bundledModel);
		expect(result.models.filter((model) => model.id === "fixture/additive-model")).toHaveLength(1);
	});

	it("loads memoized additive OpenRouter models through ModelRegistry", async () => {
		const fetchImpl: typeof fetch = async () => responseFor([apiModel("fixture/registry-model")]);
		const { ensureModelCatalogFresh } = await importCatalogModule();
		await ensureModelCatalogFresh({ fetchImpl, now: () => NOW });
		const { AuthStorage } = await import("../src/core/auth-storage.ts");
		const { ModelRegistry } = await import("../src/core/model-registry.ts");

		const registry = ModelRegistry.inMemory(AuthStorage.create(join(cache.getCacheHome(), "auth.json")));

		expect(registry.find("openrouter", "fixture/registry-model")).toBeDefined();
	});

	it("force refresh bypasses a fresh cache", async () => {
		cache.writeCache(new Date(NOW.getTime() - 60 * 60 * 1000), [cachedModel("fixture/fresh-cache")]);
		let fetchCount = 0;
		const fetchImpl: typeof fetch = async () => {
			fetchCount++;
			return responseFor([apiModel("fixture/forced-refresh")]);
		};
		const { ensureModelCatalogFresh } = await importCatalogModule();

		const result = await ensureModelCatalogFresh({
			force: true,
			fetchImpl,
			now: () => NOW,
		});

		expect(fetchCount).toBe(1);
		expect(result.source).toBe("network");
		expect(result.models.some((model) => model.id === "fixture/forced-refresh")).toBe(true);
	});
});

describe("OpenRouter model catalog cache reads", () => {
	const cache = useCatalogCache();

	it("uses a cache younger than seven days without fetching", async () => {
		cache.writeCache(new Date(NOW.getTime() - 6 * 24 * 60 * 60 * 1000), [cachedModel("fixture/fresh-cache")]);
		let fetchCount = 0;
		const fetchImpl: typeof fetch = async () => {
			fetchCount++;
			throw new Error("fresh cache must avoid network");
		};
		const { ensureModelCatalogFresh } = await importCatalogModule();

		const result = await ensureModelCatalogFresh({ fetchImpl, now: () => NOW });

		expect(fetchCount).toBe(0);
		expect(result.source).toBe("cache");
		expect(result.models.some((model) => model.id === "fixture/fresh-cache")).toBe(true);
	});

	it.each([
		["a fresh cache", new Date(NOW.getTime() - 6 * 24 * 60 * 60 * 1000), "cache"],
		["an expired cache", new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000), "bundled"],
		["no cache", undefined, "bundled"],
	] as const)("loads %s at normal startup without fetching", async (_description, fetchedAt, source) => {
		if (fetchedAt) cache.writeCache(fetchedAt, [cachedModel("fixture/startup-cache")]);
		const fetchSpy = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchSpy);
		const { loadOpenRouterCatalogAtStartup } = await importCatalogModule();

		const result = await loadOpenRouterCatalogAtStartup({ now: () => NOW });

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(result.source).toBe(source);
		expect(result.models.some((model) => model.id === "fixture/startup-cache")).toBe(source === "cache");
	});
});

describe("OpenRouter model catalog retry policy", () => {
	useCatalogCache();

	it.each([429, 500, 503, "network"])("retries transient %s and persists recovered models", async (failure) => {
		let attempts = 0;
		const fetchImpl: typeof fetch = async () => {
			if (++attempts < 3) {
				if (failure === "network") throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
				return new Response(null, { status: Number(failure) });
			}
			return responseFor([apiModel("fixture/recovered")]);
		};
		const { ensureModelCatalogFresh } = await importCatalogModule();
		const result = await ensureModelCatalogFresh({ fetchImpl });
		expect(attempts).toBe(3);
		expect(result.models.some((model) => model.id === "fixture/recovered")).toBe(true);
	});

	it.each([401, 403, 404, "json", "empty"])("does not retry permanent %s", async (failure) => {
		let attempts = 0;
		const fetchImpl: typeof fetch = async () => {
			attempts++;
			if (failure === "json") return new Response("not json");
			if (failure === "empty") return responseFor([]);
			return new Response(null, { status: Number(failure) });
		};
		const { ensureModelCatalogFresh } = await importCatalogModule();
		await expect(ensureModelCatalogFresh({ fetchImpl })).rejects.toThrow("OpenRouter");
		expect(attempts).toBe(1);
	});

	it("bounds network failures to three attempts and includes their cause", async () => {
		let attempts = 0;
		const fetchImpl: typeof fetch = async () => {
			attempts++;
			throw new TypeError("fetch failed", { cause: new Error("ENOTFOUND openrouter.ai") });
		};
		const { ensureModelCatalogFresh } = await importCatalogModule();
		await expect(ensureModelCatalogFresh({ fetchImpl })).rejects.toThrow("ENOTFOUND openrouter.ai");
		expect(attempts).toBe(3);
	});

	it.each(["seconds", "date"])("waits for Retry-After %s before recovery", async (format) => {
		const retryAt = Math.ceil(Date.now() / 1000) * 1000 + 1000;
		const retryAfter = format === "seconds" ? "1" : new Date(retryAt).toUTCString();
		const requests: number[] = [];
		const fetchImpl: typeof fetch = async () => {
			requests.push(Date.now());
			return requests.length === 1
				? new Response(null, { status: 429, headers: { "Retry-After": retryAfter } })
				: responseFor([apiModel("fixture/after-delay")]);
		};
		const { ensureModelCatalogFresh } = await importCatalogModule();
		const result = await ensureModelCatalogFresh({ fetchImpl });
		expect(requests).toHaveLength(2);
		expect(requests[1]).toBeGreaterThanOrEqual(format === "seconds" ? requests[0] + 1000 : retryAt);
		expect(result.models.some((model) => model.id === "fixture/after-delay")).toBe(true);
	});

	it.each(["60", new Date(Date.now() + 60_000).toUTCString()])(
		"does not retry before long Retry-After %s",
		async (retryAfter) => {
			let attempts = 0;
			const fetchImpl: typeof fetch = async () => {
				attempts++;
				return new Response(null, { status: 429, headers: { "Retry-After": retryAfter } });
			};
			const { ensureModelCatalogFresh } = await importCatalogModule();
			await expect(ensureModelCatalogFresh({ fetchImpl })).rejects.toThrow("HTTP 429");
			expect(attempts).toBe(1);
		},
	);
});

describe("OpenRouter model catalog cache failures", () => {
	const cache = useCatalogCache();

	it("reports refresh failure while leaving the stale cache intact", async () => {
		cache.writeCache(new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000), [cachedModel("fixture/offline-cache")]);
		const originalCache = readFileSync(cache.cachePath(), "utf8");
		const fetchImpl: typeof fetch = async () => {
			throw new Error("offline");
		};
		const { ensureModelCatalogFresh } = await importCatalogModule();

		await expect(ensureModelCatalogFresh({ fetchImpl, now: () => NOW })).rejects.toThrow("offline");
		expect(readFileSync(cache.cachePath(), "utf8")).toBe(originalCache);
	});

	it("rejects an invalid response without creating a cache", async () => {
		const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ unexpected: [] }), { status: 200 });
		const { ensureModelCatalogFresh } = await importCatalogModule();

		await expect(ensureModelCatalogFresh({ fetchImpl, now: () => NOW })).rejects.toThrow("no data array");
		expect(() => readFileSync(cache.cachePath(), "utf8")).toThrow();
	});

	it("aborts a stale catalog fetch after five seconds", async () => {
		vi.useFakeTimers();
		try {
			let markFetchStarted = () => {};
			const fetchStarted = new Promise<void>((resolve) => {
				markFetchStarted = resolve;
			});
			const fetchImpl: typeof fetch = async (_input, init) => {
				markFetchStarted();
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
						once: true,
					});
				});
			};
			const { ensureModelCatalogFresh } = await importCatalogModule();

			const pending = ensureModelCatalogFresh({ fetchImpl, now: () => NOW });
			const rejection = expect(pending).rejects.toThrow(/timed out.*5000/);
			await fetchStarted;
			await vi.advanceTimersByTimeAsync(5000);
			await rejection;
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports cache write failures with the destination path", async () => {
		const blockedCacheHome = join(cache.getCacheHome(), "blocked");
		writeFileSync(blockedCacheHome, "blocked", "utf8");
		process.env.XDG_CACHE_HOME = blockedCacheHome;
		const fetchImpl: typeof fetch = async () => responseFor([apiModel("fixture/write-failure")]);
		const { ensureModelCatalogFresh } = await importCatalogModule();

		await expect(ensureModelCatalogFresh({ fetchImpl, now: () => NOW })).rejects.toThrow("openrouter.json");
	});

	it("reports refresh errors when the cache contains invalid entries", async () => {
		mkdirSync(join(cache.getCacheHome(), "pi", "models"), { recursive: true });
		writeFileSync(
			cache.cachePath(),
			JSON.stringify({
				fetchedAt: NOW.toISOString(),
				models: [{ nonsense: true }, "not-an-object"],
			}),
			"utf8",
		);
		let fetchCount = 0;
		const fetchImpl: typeof fetch = async () => {
			fetchCount++;
			throw new Error("offline");
		};
		const { ensureModelCatalogFresh } = await importCatalogModule();

		await expect(ensureModelCatalogFresh({ fetchImpl, now: () => NOW })).rejects.toThrow("offline");
		expect(fetchCount).toBe(1);
	});

	it("reports exhausted HTTP retries without touching the cache", async () => {
		cache.writeCache(new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000), [cachedModel("fixture/http-error-cache")]);
		const originalCache = readFileSync(cache.cachePath(), "utf8");
		const fetchImpl: typeof fetch = async () =>
			new Response(JSON.stringify({ error: "upstream unavailable" }), {
				status: 502,
			});
		const { ensureModelCatalogFresh } = await importCatalogModule();

		await expect(ensureModelCatalogFresh({ fetchImpl, now: () => NOW })).rejects.toThrow("HTTP 502");
		expect(readFileSync(cache.cachePath(), "utf8")).toBe(originalCache);
	});
});

describe("OpenRouter model catalog CLI startup", () => {
	const cliPath = resolve(__dirname, "../src/cli.ts");
	const tempDirs: string[] = [];

	function createTempDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	function seedOfflineCache(cacheHome: string): string {
		const modelDir = join(cacheHome, "pi", "models");
		mkdirSync(modelDir, { recursive: true });
		const cacheFile = join(modelDir, "openrouter.json");
		const catalog = {
			fetchedAt: new Date().toISOString(),
			models: [cachedModel("fixture/offline-cli-model")],
		};
		writeFileSync(cacheFile, JSON.stringify(catalog), "utf8");
		return cacheFile;
	}

	async function runCli(
		args: string[],
		cacheHome: string,
	): Promise<{ stdout: string; stderr: string; code: number | null }> {
		const agentDir = createTempDir("pi-model-catalog-agent-");
		return await new Promise((resolvePromise, reject) => {
			const child = spawn(process.execPath, ["--experimental-strip-types", cliPath, ...args], {
				cwd: agentDir,
				env: {
					...process.env,
					[ENV_AGENT_DIR]: agentDir,
					XDG_CACHE_HOME: cacheHome,
					PI_OFFLINE: "1",
					OPENROUTER_API_KEY: "test-key",
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			child.on("error", reject);
			child.on("close", (code) => {
				resolvePromise({ stdout, stderr, code });
			});
		});
	}

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("merges a fresh offline cache into --list-models before registry creation", async () => {
		const cacheHome = createTempDir("pi-model-catalog-cli-");
		seedOfflineCache(cacheHome);

		const result = await runCli(["--list-models"], cacheHome);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("fixture/offline-cli-model");
	}, 30_000);

	it("--refresh-models reports offline failure without a success summary or cache change", async () => {
		const cacheHome = createTempDir("pi-model-catalog-cli-");
		const cacheFile = seedOfflineCache(cacheHome);

		const originalCache = readFileSync(cacheFile, "utf8");
		const result = await runCli(["--refresh-models"], cacheHome);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("OpenRouter");
		expect(result.stdout).not.toContain("OpenRouter models:");
		expect(readFileSync(cacheFile, "utf8")).toBe(originalCache);
	}, 30_000);
});
