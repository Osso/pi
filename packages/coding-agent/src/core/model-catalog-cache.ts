import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Api, getModels, type Model } from "@earendil-works/pi-ai/compat";
import { getUserCacheRoot } from "../config.ts";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const bundledOpenRouterModels = getModels("openrouter") as Model<Api>[];

interface CachedCatalog {
	fetchedAt: string;
	models: Model<Api>[];
}

export interface EnsureModelCatalogOptions {
	force?: boolean;
	fetchImpl?: typeof fetch;
	now?: () => Date;
}

export interface LoadOpenRouterCatalogAtStartupOptions {
	now?: () => Date;
}

export interface ModelCatalogRefreshResult {
	models: Model<Api>[];
	source: "bundled" | "cache" | "network";
	fetchedCount: number;
	cachedCount: number;
	bundledCount: number;
	cachePath: string;
}

let memoizedOpenRouterModels: Model<Api>[] | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function hasValidCachedIdentity(value: Record<string, unknown>): boolean {
	return (
		typeof value.id === "string" &&
		value.id.length > 0 &&
		typeof value.name === "string" &&
		value.name.length > 0 &&
		value.api === "openai-completions" &&
		value.provider === "openrouter" &&
		value.baseUrl === OPENROUTER_BASE_URL &&
		typeof value.reasoning === "boolean"
	);
}

function hasValidCachedCost(cost: Record<string, unknown>): boolean {
	return [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].every(isFiniteNumber);
}

function isCachedModel(value: unknown): value is Model<Api> {
	if (!isRecord(value) || !isRecord(value.cost)) return false;
	const input = value.input;
	const validInput = Array.isArray(input) && input.every((modality) => modality === "text" || modality === "image");
	return (
		hasValidCachedIdentity(value) &&
		hasValidCachedCost(value.cost) &&
		validInput &&
		isFiniteNumber(value.contextWindow) &&
		value.contextWindow > 0 &&
		isFiniteNumber(value.maxTokens) &&
		value.maxTokens > 0
	);
}

function parseCachedCatalog(value: unknown): CachedCatalog | undefined {
	if (!isRecord(value) || typeof value.fetchedAt !== "string" || !Array.isArray(value.models)) return undefined;
	if (!Number.isFinite(Date.parse(value.fetchedAt)) || !value.models.every(isCachedModel)) return undefined;
	return { fetchedAt: value.fetchedAt, models: value.models };
}

async function readCachedCatalog(cachePath: string): Promise<CachedCatalog | undefined> {
	try {
		const content = await readFile(cachePath, "utf8");
		return parseCachedCatalog(JSON.parse(content));
	} catch {
		return undefined;
	}
}

function roundCost(value: number): number {
	return Number(value.toFixed(6));
}

function parseCost(value: unknown): number {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : 0;
	return Number.isFinite(parsed) ? roundCost(parsed * 1_000_000) : 0;
}

function positiveNumberOr(value: unknown, fallback: number): number {
	return isFiniteNumber(value) && value > 0 ? value : fallback;
}

function mapOpenRouterModel(value: unknown): Model<Api> | undefined {
	if (!isRecord(value) || typeof value.id !== "string") return undefined;
	const supportedParameters = Array.isArray(value.supported_parameters)
		? value.supported_parameters.filter((parameter): parameter is string => typeof parameter === "string")
		: [];
	if (!supportedParameters.includes("tools")) return undefined;

	const architecture = isRecord(value.architecture) ? value.architecture : undefined;
	const modality = typeof architecture?.modality === "string" ? architecture.modality : "";
	const pricing = isRecord(value.pricing) ? value.pricing : undefined;
	const topProvider = isRecord(value.top_provider) ? value.top_provider : undefined;
	const input: ("text" | "image")[] = modality.includes("image") ? ["text", "image"] : ["text"];

	return {
		id: value.id,
		name: typeof value.name === "string" ? value.name : value.id,
		api: "openai-completions",
		baseUrl: OPENROUTER_BASE_URL,
		provider: "openrouter",
		reasoning: supportedParameters.includes("reasoning"),
		input,
		cost: {
			input: parseCost(pricing?.prompt),
			output: parseCost(pricing?.completion),
			cacheRead: parseCost(pricing?.input_cache_read),
			cacheWrite: parseCost(pricing?.input_cache_write),
		},
		contextWindow: positiveNumberOr(value.context_length, 4096),
		maxTokens: positiveNumberOr(topProvider?.max_completion_tokens, 4096),
	};
}

async function fetchOpenRouterCatalogWith(fetchImpl: typeof fetch, abortSignal?: AbortSignal): Promise<Model<Api>[]> {
	const response = await fetchImpl(OPENROUTER_MODELS_URL, { signal: abortSignal });
	if (!response.ok) throw new Error(`OpenRouter model catalog request failed with HTTP ${response.status}`);
	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new Error("OpenRouter model catalog response has no data array");
	}
	const models = payload.data.map(mapOpenRouterModel).filter((model): model is Model<Api> => model !== undefined);
	if (models.length === 0) throw new Error("OpenRouter model catalog contains no tool-capable models");
	return models;
}

export async function fetchOpenRouterCatalog(abortSignal?: AbortSignal): Promise<Model<Api>[]> {
	return fetchOpenRouterCatalogWith(fetch, abortSignal);
}

function mergeWithBundledModels(refreshedModels: Model<Api>[]): Model<Api>[] {
	const modelsById = new Map(bundledOpenRouterModels.map((model) => [model.id, model]));
	for (const model of refreshedModels) {
		if (!modelsById.has(model.id)) modelsById.set(model.id, model);
	}
	return Array.from(modelsById.values());
}

async function writeCachedCatalog(cachePath: string, catalog: CachedCatalog): Promise<void> {
	const temporaryPath = join(dirname(cachePath), `.openrouter-${process.pid}-${randomUUID()}.tmp`);
	try {
		await mkdir(dirname(cachePath), { recursive: true });
		await writeFile(temporaryPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
		await rename(temporaryPath, cachePath);
	} catch {
		try {
			await unlink(temporaryPath);
		} catch {
			// Best-effort cache writes must not affect startup.
		}
	}
}

function buildResult(
	models: Model<Api>[],
	source: ModelCatalogRefreshResult["source"],
	cachePath: string,
	counts: { fetched: number; cached: number },
): ModelCatalogRefreshResult {
	memoizedOpenRouterModels = models;
	return {
		models,
		source,
		fetchedCount: counts.fetched,
		cachedCount: counts.cached,
		bundledCount: bundledOpenRouterModels.length,
		cachePath,
	};
}

function isCacheFresh(cachedCatalog: CachedCatalog | undefined, now: Date): cachedCatalog is CachedCatalog {
	if (!cachedCatalog) return false;
	return now.getTime() - Date.parse(cachedCatalog.fetchedAt) < CACHE_MAX_AGE_MS;
}

async function refreshCachedCatalog(
	options: EnsureModelCatalogOptions,
	cachePath: string,
	cachedCatalog: CachedCatalog | undefined,
	now: () => Date,
): Promise<ModelCatalogRefreshResult> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const fetchedModels = await fetchOpenRouterCatalogWith(options.fetchImpl ?? fetch, controller.signal);
		await writeCachedCatalog(cachePath, { fetchedAt: now().toISOString(), models: fetchedModels });
		return buildResult(mergeWithBundledModels(fetchedModels), "network", cachePath, {
			fetched: fetchedModels.length,
			cached: cachedCatalog?.models.length ?? 0,
		});
	} catch {
		// Bundled models are the guaranteed floor whenever a refresh fails.
		return buildResult(mergeWithBundledModels([]), "bundled", cachePath, {
			fetched: 0,
			cached: cachedCatalog?.models.length ?? 0,
		});
	} finally {
		clearTimeout(timeout);
	}
}

export async function loadOpenRouterCatalogAtStartup(
	options: LoadOpenRouterCatalogAtStartupOptions = {},
): Promise<ModelCatalogRefreshResult> {
	const now = options.now ?? (() => new Date());
	const cachePath = join(getUserCacheRoot(), "models", "openrouter.json");
	const cachedCatalog = await readCachedCatalog(cachePath);
	const cachedCount = cachedCatalog?.models.length ?? 0;
	if (isCacheFresh(cachedCatalog, now())) {
		return buildResult(mergeWithBundledModels(cachedCatalog.models), "cache", cachePath, {
			fetched: 0,
			cached: cachedCount,
		});
	}
	return buildResult(mergeWithBundledModels([]), "bundled", cachePath, {
		fetched: 0,
		cached: cachedCount,
	});
}

export async function ensureModelCatalogFresh(
	options: EnsureModelCatalogOptions = {},
): Promise<ModelCatalogRefreshResult> {
	const now = options.now ?? (() => new Date());
	const cachePath = join(getUserCacheRoot(), "models", "openrouter.json");
	const cachedCatalog = await readCachedCatalog(cachePath);
	if (!options.force && isCacheFresh(cachedCatalog, now())) {
		return buildResult(mergeWithBundledModels(cachedCatalog.models), "cache", cachePath, {
			fetched: 0,
			cached: cachedCatalog.models.length,
		});
	}
	return refreshCachedCatalog(options, cachePath, cachedCatalog, now);
}

export function getOpenRouterCatalogModels(): Model<Api>[] {
	return memoizedOpenRouterModels ?? bundledOpenRouterModels;
}
