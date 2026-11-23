import type { ExtensionCommandContext } from "../../../src/core/extensions/types.ts";
import { formatUsageError, formatUsagePercent, formatUsageReset, MISSING, type UsageSection } from "./usage-shared.ts";

export function formatDeepseekReport(rows: DeepseekRow[]): UsageSection {
	return { title: `DeepSeek pool usage; ${MISSING} = not reported`, table: formatDeepseekUsage(rows) };
}

const DEEPSEEK_POOL_PROVIDERS = [
	"opencode-go",
	"commandcode",
	"open-grove",
	"deepseek",
	"openrouter",
	"openrouter-gc",
] as const;

const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

const OPEN_GROVE_USAGE_URL = "https://api.pgsgrove.com/v1/usage";

const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";

const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

const COMMANDCODE_BASE = "https://api.commandcode.ai";

export interface DeepseekWindow {
	percent: number;
	/** Epoch seconds. */
	resetsAt: number | null;
}

export interface DeepseekRow {
	provider: string;
	day: DeepseekWindow | null;
	week: DeepseekWindow | null;
	month: DeepseekWindow | null;
	/** Remaining credits or balance, as display text. */
	balance: string | null;
	status?: string;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function readFiniteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readIsoEpochSeconds(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const parsed = Date.parse(value);
	// A zero (epoch) reset means not reported, as for numeric resets.
	return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed / 1000) : null;
}

function deepseekWindow(percent: unknown, resetsAt: number | null): DeepseekWindow | null {
	const value = readFiniteNumber(percent);
	return value === null ? null : { percent: value, resetsAt };
}

function percentWindow(source: unknown): DeepseekWindow | null {
	const record = asRecord(source);
	return record ? deepseekWindow(record.percent, readIsoEpochSeconds(record.resetsAt)) : null;
}

export function formatUsd(value: number): string {
	return `$${value.toFixed(2)}`;
}

export function mapOpencodeGoUsage(payload: unknown): Pick<DeepseekRow, "day" | "week" | "month"> {
	const usage = asRecord(asRecord(payload)?.usage);
	return {
		day: percentWindow(usage?.rolling),
		week: percentWindow(usage?.weekly),
		month: percentWindow(usage?.monthly),
	};
}

export function mapOpenGroveUsage(payload: unknown): Pick<DeepseekRow, "day" | "week" | "month"> {
	const record = asRecord(payload);
	return {
		day: deepseekWindow(record?.daily_used_percent, readIsoEpochSeconds(record?.daily_resets_at)),
		week: deepseekWindow(record?.weekly_used_percent, readIsoEpochSeconds(record?.weekly_resets_at)),
		month: null,
	};
}

const OPENROUTER_LIMIT_COLUMNS: Record<string, "day" | "week" | "month"> = {
	daily: "day",
	weekly: "week",
	monthly: "month",
};

type OpenRouterUsage = Partial<Pick<DeepseekRow, "day" | "week" | "month">> & Pick<DeepseekRow, "balance">;

/** The key limit fills the column named by its `limit_reset`; a key without `limit_reset` reports a weekly limit. */
export function mapOpenRouterUsage(keyPayload: unknown, creditsPayload: unknown): OpenRouterUsage {
	const key = asRecord(asRecord(keyPayload)?.data);
	const limit = readFiniteNumber(key?.limit);
	const remaining = readFiniteNumber(key?.limit_remaining);
	const resetsAt = readIsoEpochSeconds(asRecord(key?.effective_budget)?.resets_at);
	const window =
		limit !== null && limit > 0 && remaining !== null
			? deepseekWindow(((limit - remaining) / limit) * 100, resetsAt)
			: null;
	const column = key?.limit_reset === undefined ? "week" : OPENROUTER_LIMIT_COLUMNS[String(key.limit_reset)];
	const credits = asRecord(asRecord(creditsPayload)?.data);
	const total = readFiniteNumber(credits?.total_credits);
	const used = readFiniteNumber(credits?.total_usage);
	const balance = total !== null && used !== null ? formatUsd(total - used) : null;
	return column ? { [column]: window, balance } : { balance };
}

export function mapDeepseekBalance(payload: unknown): Pick<DeepseekRow, "balance"> {
	const infos = asRecord(payload)?.balance_infos;
	if (!Array.isArray(infos)) return { balance: null };
	const usd = infos.map(asRecord).find((info) => info?.currency === "USD");
	const total = typeof usd?.total_balance === "string" ? Number.parseFloat(usd.total_balance) : Number.NaN;
	return { balance: Number.isFinite(total) ? formatUsd(total) : null };
}

export function mapCommandCodeUsage(
	creditsPayload: unknown,
	subscriptionPayload: unknown,
	summaryPayload: unknown,
): Pick<DeepseekRow, "day" | "week" | "month" | "balance"> {
	const credits = asRecord(creditsPayload);
	const windows = asRecord(credits?.windowLimits);
	const monthly = asRecord(credits?.credits);
	const subscription = asRecord(asRecord(subscriptionPayload)?.data);
	const summary = asRecord(summaryPayload);

	const windowPercent = (window: unknown): DeepseekWindow | null => {
		const record = asRecord(window);
		const used = readFiniteNumber(record?.used);
		const cap = readFiniteNumber(record?.cap);
		if (used === null || cap === null || cap <= 0) return null;
		const resetMs = readFiniteNumber(record?.resetAt);
		const resetsAt = resetMs === null || resetMs <= 0 ? null : Math.round(resetMs / 1000);
		return { percent: (used / cap) * 100, resetsAt };
	};

	const monthlyRemaining = readFiniteNumber(monthly?.monthlyCredits);
	const monthlyUsed = readFiniteNumber(summary?.totalMonthlyCredits);
	const allowance = monthlyRemaining !== null && monthlyUsed !== null ? monthlyRemaining + monthlyUsed : null;

	return {
		day: windowPercent(windows?.fiveHour),
		week: windowPercent(windows?.weekly),
		month:
			allowance !== null && allowance > 0 && monthlyUsed !== null
				? {
						percent: (monthlyUsed / allowance) * 100,
						resetsAt: readIsoEpochSeconds(subscription?.currentPeriodEnd),
					}
				: null,
		balance: monthlyRemaining === null ? null : formatUsd(monthlyRemaining),
	};
}

export function formatDeepseekUsage(rows: DeepseekRow[]): string {
	const balanceWidth = Math.max("Balance".length, ...rows.map((row) => (row.balance ?? MISSING).length));
	const providerWidth = Math.max("Provider".length, ...rows.map((row) => row.provider.length));
	const lines = [
		formatDeepseekColumns(
			["Day", "Week", "Month", "Balance", "Provider", "Resets Central (day | week | month)"],
			balanceWidth,
			providerWidth,
		),
	];
	for (const row of rows) {
		const resets = `${formatUsageReset(row.day)} | ${formatUsageReset(row.week)} | ${formatUsageReset(row.month)}`;
		lines.push(
			formatDeepseekColumns(
				[
					formatUsagePercent(row.day),
					formatUsagePercent(row.week),
					formatUsagePercent(row.month),
					row.balance ?? MISSING,
					row.provider,
					row.status ?? resets,
				],
				balanceWidth,
				providerWidth,
			),
		);
	}
	return lines.join("\n");
}

function formatDeepseekColumns(
	cells: [string, string, string, string, string, string],
	balanceWidth: number,
	providerWidth: number,
): string {
	const [day, week, month, balance, provider, details] = cells;
	return [
		day.padEnd(6),
		week.padEnd(6),
		month.padEnd(6),
		balance.padEnd(balanceWidth),
		provider.padEnd(providerWidth),
		details,
	]
		.join("  ")
		.trimEnd();
}

export async function fetchUsageJson(url: string, apiKey: string, label: string): Promise<unknown> {
	const response = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` } });
	const text = await response.text();
	if (!response.ok)
		throw new Error(`${label} usage request failed (${response.status}): ${text || response.statusText}`);
	return text ? (JSON.parse(text) as unknown) : {};
}

async function readOpenRouterUsage(apiKey: string): Promise<OpenRouterUsage> {
	const [keyPayload, creditsPayload] = await Promise.all([
		fetchUsageJson(OPENROUTER_KEY_URL, apiKey, "OpenRouter"),
		fetchUsageJson(OPENROUTER_CREDITS_URL, apiKey, "OpenRouter"),
	]);
	return mapOpenRouterUsage(keyPayload, creditsPayload);
}

async function readCommandCodeUsage(apiKey: string): Promise<Partial<DeepseekRow>> {
	const headers = { authorization: `Bearer ${apiKey}`, accept: "application/json" };
	const fetchJson = async (path: string): Promise<unknown> => {
		const response = await fetch(COMMANDCODE_BASE + path, { headers });
		if (!response.ok) throw new Error(`Command Code usage request failed (${response.status})`);
		return (await response.json()) as unknown;
	};
	const whoami = asRecord(await fetchJson("/alpha/whoami"));
	const orgId = typeof asRecord(whoami?.org)?.id === "string" ? (asRecord(whoami?.org)?.id as string) : null;
	const query = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
	const [credits, subscription] = await Promise.all([
		fetchJson(`/alpha/billing/credits${query}`),
		fetchJson(`/alpha/billing/subscriptions${query}`),
	]);
	const periodStart = asRecord(asRecord(subscription)?.data)?.currentPeriodStart;
	const summaryQuery = new URLSearchParams(orgId ? { orgId } : {});
	if (typeof periodStart === "string") summaryQuery.set("since", periodStart);
	const summary = await fetchJson(`/alpha/usage/summary${summaryQuery.size > 0 ? `?${summaryQuery.toString()}` : ""}`);
	return mapCommandCodeUsage(credits, subscription, summary);
}

const DEEPSEEK_USAGE_READERS: Record<string, (apiKey: string) => Promise<Partial<DeepseekRow>>> = {
	"opencode-go": async (apiKey) =>
		mapOpencodeGoUsage(await fetchUsageJson(OPENCODE_GO_USAGE_URL, apiKey, "OpenCode Go")),
	commandcode: readCommandCodeUsage,
	"open-grove": async (apiKey) => mapOpenGroveUsage(await fetchUsageJson(OPEN_GROVE_USAGE_URL, apiKey, "Open Grove")),
	openrouter: readOpenRouterUsage,
	"openrouter-gc": readOpenRouterUsage,
	deepseek: async (apiKey) => mapDeepseekBalance(await fetchUsageJson(DEEPSEEK_BALANCE_URL, apiKey, "DeepSeek")),
};

async function readDeepseekRow(ctx: ExtensionCommandContext, providerId: string): Promise<DeepseekRow> {
	const row: DeepseekRow = { provider: providerId, day: null, week: null, month: null, balance: null };
	const reader = DEEPSEEK_USAGE_READERS[providerId];
	if (!reader) return { ...row, status: "not reported" };
	if (!ctx.modelRegistry.authStorage.has(providerId)) return { ...row, status: "not logged in" };
	try {
		const apiKey = await ctx.modelRegistry.authStorage.getApiKey(providerId, { includeFallback: false });
		if (!apiKey) return { ...row, status: "not logged in" };
		return { ...row, ...(await reader(apiKey)) };
	} catch (error) {
		return { ...row, status: `error: ${formatUsageError(error)}` };
	}
}

export function readDeepseekRows(ctx: ExtensionCommandContext): Promise<DeepseekRow[]> {
	return Promise.all(DEEPSEEK_POOL_PROVIDERS.map((providerId) => readDeepseekRow(ctx, providerId)));
}
