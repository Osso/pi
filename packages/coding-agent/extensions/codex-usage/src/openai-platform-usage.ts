import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "../../../src/config.ts";
import type { ExtensionCommandContext } from "../../../src/core/extensions/types.ts";
import { asRecord, fetchUsageJson, formatUsd, readFiniteNumber } from "./deepseek-usage.ts";
import { formatUsageError, MISSING, sanitizeUsageText, type UsageSection } from "./usage-shared.ts";

const OPENAI_PLATFORM_BASE = "https://api.openai.com/v1";

export interface OpenAiPlatformRow {
	provider: string;
	account: string;
	/** Month-to-date spend and today's spend, formatted as USD. */
	today: string | null;
	month: string | null;
	status?: string;
}

const OPENAI_PLATFORM_TITLE = `OpenAI API platform spend; prepaid credit balance is not exposed by the OpenAI API; ${MISSING} = not reported`;

const OPENAI_COSTS_BUCKET_WIDTH = "1d";

const OPENAI_COSTS_MONTH_BUCKETS = "31";

const PLATFORM_AMOUNT_WIDTH = 8;

function openAiPlatformProviders(ctx: ExtensionCommandContext): string[] {
	const ids = new Set(
		ctx.modelRegistry
			.getAll()
			.filter((model) => model.baseUrl.replace(/\/$/, "") === OPENAI_PLATFORM_BASE)
			.map((model) => model.provider),
	);
	return [...ids].filter((providerId) => ctx.modelRegistry.authStorage.has(providerId));
}

function openAiAdminKeyPath(providerId: string): string {
	return join(getAgentDir(), `${providerId}-admin.key`);
}

export async function readOpenAiPlatformRows(ctx: ExtensionCommandContext): Promise<OpenAiPlatformRow[]> {
	return Promise.all(openAiPlatformProviders(ctx).map((providerId) => readOpenAiPlatformRow(ctx, providerId)));
}

async function readOpenAiPlatformRow(ctx: ExtensionCommandContext, providerId: string): Promise<OpenAiPlatformRow> {
	const row: OpenAiPlatformRow = { provider: providerId, account: providerId, today: null, month: null };
	try {
		const apiKey = await ctx.modelRegistry.authStorage.getApiKey(providerId, { includeFallback: false });
		if (!apiKey) return { ...row, status: "not logged in" };
		const account = sanitizeUsageText((await readOpenAiAccountEmail(apiKey)) ?? providerId);
		const adminKeyPath = openAiAdminKeyPath(providerId);
		const adminKey = await readOptionalText(adminKeyPath);
		if (!adminKey) return { ...row, account, status: `no admin key: ${adminKeyPath}` };
		const buckets = await readOpenAiCostBuckets(adminKey);
		const spend = sumOpenAiSpend(buckets, startOfUtcToday());
		return { ...row, account, today: formatUsd(spend.today), month: formatUsd(spend.month) };
	} catch (error) {
		return { ...row, status: `error: ${formatUsageError(error)}` };
	}
}

async function readOptionalText(path: string): Promise<string | null> {
	try {
		const value = (await readFile(path, "utf8")).trim();
		return value.length > 0 ? value : null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function readOpenAiAccountEmail(apiKey: string): Promise<string | null> {
	const email = asRecord(await fetchUsageJson(`${OPENAI_PLATFORM_BASE}/me`, apiKey, "OpenAI API"))?.email;
	return typeof email === "string" && email.length > 0 ? email : null;
}

async function readOpenAiCostBuckets(adminKey: string): Promise<unknown[]> {
	const query = new URLSearchParams({
		start_time: String(Math.floor(startOfUtcMonth() / 1000)),
		bucket_width: OPENAI_COSTS_BUCKET_WIDTH,
		limit: OPENAI_COSTS_MONTH_BUCKETS,
	});
	const url = `${OPENAI_PLATFORM_BASE}/organization/costs?${query.toString()}`;
	const buckets = asRecord(await fetchUsageJson(url, adminKey, "OpenAI API costs"))?.data;
	if (!Array.isArray(buckets)) throw new Error("OpenAI API costs response has no buckets");
	return buckets;
}

/** Sum the daily cost buckets, splitting the buckets that start on the current UTC day. */

function sumOpenAiSpend(buckets: unknown[], todayStartMs: number): { today: number; month: number } {
	let today = 0;
	let month = 0;
	for (const bucket of buckets) {
		const amount = sumCostAmounts(asRecord(bucket)?.results);
		month += amount;
		const bucketStartMs = (readFiniteNumber(asRecord(bucket)?.start_time) ?? 0) * 1000;
		if (bucketStartMs >= todayStartMs) today += amount;
	}
	return { today, month };
}

function startOfUtcMonth(now = new Date()): number {
	return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

function startOfUtcToday(now = new Date()): number {
	return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function sumCostAmounts(results: unknown): number {
	if (!Array.isArray(results)) return 0;
	let total = 0;
	for (const result of results) {
		const amount = asRecord(asRecord(result)?.amount);
		if (amount?.currency !== "usd") continue;
		total += readCostValue(amount.value) ?? 0;
	}
	return total;
}

function readCostValue(value: unknown): number | null {
	if (typeof value === "string") {
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return readFiniteNumber(value);
}

export function formatOpenAiPlatformReport(rows: OpenAiPlatformRow[]): UsageSection {
	const providerWidth = Math.max("Provider".length, ...rows.map((row) => row.provider.length));
	const accountWidth = Math.max("Account".length, ...rows.map((row) => row.account.length));
	const header = formatPlatformColumns(
		["Today", "Month", "Provider", "Account", "Status"],
		providerWidth,
		accountWidth,
	);
	const body = rows.map((row) =>
		formatPlatformColumns(
			[row.today ?? MISSING, row.month ?? MISSING, row.provider, row.account, row.status ?? ""],
			providerWidth,
			accountWidth,
		),
	);
	return { title: OPENAI_PLATFORM_TITLE, table: [header, ...body].join("\n") };
}

function formatPlatformColumns(
	cells: [string, string, string, string, string],
	providerWidth: number,
	accountWidth: number,
): string {
	const [today, month, provider, account, status] = cells;
	return [
		today.padEnd(PLATFORM_AMOUNT_WIDTH),
		month.padEnd(PLATFORM_AMOUNT_WIDTH),
		provider.padEnd(providerWidth),
		account.padEnd(accountWidth),
		status,
	]
		.join("  ")
		.trimEnd();
}
