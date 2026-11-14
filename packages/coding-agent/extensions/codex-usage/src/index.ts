import {
	type CodexRateLimitWindow,
	handleUsageRead,
	handleUsageReset,
	readCodexUsage,
	sendCodexUsageReport,
} from "./codex-usage.ts";

export {
	CodexAccountInfo,
	CodexAdditionalRateLimitPayload,
	CodexCredits,
	CodexCreditsPayload,
	CodexRateLimit,
	CodexRateLimitDetailsPayload,
	CodexRateLimitWindow,
	CodexRateLimitWindowPayload,
	CodexUsage,
	CodexUsagePayload,
	formatCodexUsage,
	mapCodexUsagePayload,
	resolveCodexAccountId,
	resolveCodexAccountInfo,
	resolveCodexDisplayEmail,
} from "./codex-usage.ts";

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "../../../src/config.ts";
import { CODEX_FALLBACK_PROVIDERS } from "../../../src/core/codex-quota-fallback.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../../src/core/extensions/types.ts";
import {
	type AccountUsageRow,
	formatUsageError,
	formatUsagePercent,
	formatUsageReset,
	MISSING,
	RESET_CREDITS_LEGEND,
	SCOPE_TITLES,
	sanitizeUsageText,
	type UsageCell,
	type UsageScope,
	type UsageSection,
} from "./usage-shared.ts";

const OPENAI_PLATFORM_BASE = "https://api.openai.com/v1";

const USAGE_ARGUMENTS = ["all", "claude", "openai", "deepseek", "reset"];

export default function codexUsageExtension(pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: "Show Codex, Claude, or DeepSeek usage; scope with all, claude, or openai",
		getArgumentCompletions: (prefix) => {
			const matches = USAGE_ARGUMENTS.filter((option) => option.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const commandArgs = args.trim();
			if (isUsageScope(commandArgs)) {
				await handleUsageAccounts(ctx, pi, commandArgs);
				return;
			}
			if (commandArgs === "deepseek") {
				await handleUsageDeepseek(ctx, pi);
				return;
			}
			if (ctx.model?.provider === "claude-bridge") {
				await dispatchClaudeUsageRequest(args, ctx, pi);
				return;
			}
			if (commandArgs === "reset") {
				await handleUsageReset(ctx, pi);
				return;
			}
			if (commandArgs.length > 0) {
				ctx.ui.notify(`Usage: /usage [${USAGE_ARGUMENTS.join("|")}]`, "warning");
				return;
			}
			await handleUsageRead(ctx, pi);
		},
	});
}

interface UsageWindow {
	percent: number;
	resetsAt: string | null;
}

type ClaudeAccountUsage =
	| { account: string; selected: boolean; fiveHour: UsageWindow | null; weekly: UsageWindow | null }
	| { account: string; selected: boolean; error: string };

function isUsageScope(value: string): value is UsageScope {
	return value === "all" || value === "claude" || value === "openai";
}

async function handleUsageAccounts(ctx: ExtensionCommandContext, pi: ExtensionAPI, scope: UsageScope): Promise<void> {
	const [accountRows, platformRows, deepseekRows] = await Promise.all([
		readAccountRows(ctx, pi, scope),
		scope === "claude" ? Promise.resolve<OpenAiPlatformRow[]>([]) : readOpenAiPlatformRows(ctx),
		scope === "all" ? readDeepseekRows(ctx) : Promise.resolve<DeepseekRow[]>([]),
	]);
	const sections = [formatAccountReport(scope, accountRows)];
	if (platformRows.length > 0) sections.push(formatOpenAiPlatformReport(platformRows));
	if (deepseekRows.length > 0) sections.push(formatDeepseekReport(deepseekRows));
	sendUsageReport(ctx, pi, sections, scope === "all" ? "usage-all" : `usage-${scope}`);
}

async function readAccountRows(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	scope: UsageScope,
): Promise<AccountUsageRow[]> {
	// The bridge must claim its request during emit, so start it before awaiting either report.
	const claudeRows = scope === "openai" ? [] : readClaudeAccountRows(pi);
	const codexRows =
		scope === "claude"
			? []
			: Promise.all([...CODEX_FALLBACK_PROVIDERS.keys()].map((id) => readCodexAccountRow(ctx, id)));
	const [claude, codex] = await Promise.all([claudeRows, codexRows]);
	return [...claude, ...codex];
}

function formatAccountReport(scope: UsageScope, rows: AccountUsageRow[]): UsageSection {
	const legend = scope === "claude" ? `${MISSING} = not reported` : RESET_CREDITS_LEGEND;
	const accountWidth = Math.max("Account".length, ...rows.map((row) => row.account.length));
	const header = ["5h", "Week", "Resets", "Provider", "Account", "Resets Central (5h | week)"];
	const table = [
		formatAccountColumns(header, accountWidth),
		...rows.map((row) => formatAccountRow(row, accountWidth)),
	].join("\n");
	return { title: `${SCOPE_TITLES[scope]}; ${legend}`, table };
}

function formatDeepseekReport(rows: DeepseekRow[]): UsageSection {
	return { title: `DeepSeek pool usage; ${MISSING} = not reported`, table: formatDeepseekUsage(rows) };
}

interface OpenAiPlatformRow {
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

async function readOpenAiPlatformRows(ctx: ExtensionCommandContext): Promise<OpenAiPlatformRow[]> {
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

function formatOpenAiPlatformReport(rows: OpenAiPlatformRow[]): UsageSection {
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

function formatPlatformColumns(cells: string[], providerWidth: number, accountWidth: number): string {
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

function sendUsageReport(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	sections: UsageSection[],
	customType: string,
): void {
	// Custom messages render as Markdown: fence each table so `-` cells and column padding stay literal.
	const content = sections.map((section) => `${section.title}\n\n\`\`\`\n${section.table}\n\`\`\``).join("\n\n");
	const notification = sections.map((section) => `${section.title}\n${section.table}`).join("\n\n");
	sendCodexUsageReport(ctx, pi, content, customType, notification);
}

async function readCodexAccountRow(ctx: ExtensionCommandContext, providerId: string): Promise<AccountUsageRow> {
	const selected = ctx.model?.provider === providerId ? " *" : "";
	const row = { provider: "Codex", account: `${providerId}${selected}`, fiveHour: null, weekly: null };
	try {
		if (!ctx.modelRegistry.authStorage.has(providerId)) return { ...row, status: "not logged in" };
		const usage = await readCodexUsage(ctx, providerId);
		const plan = usage.planType ? ` (${sanitizeUsageText(usage.planType)})` : "";
		const account = `${sanitizeUsageText(usage.email ?? usage.accountId ?? providerId)}${plan} [${providerId}]${selected}`;
		const limit = usage.limits.find((entry) => entry.limitId === "codex");
		const windows = [limit?.primary, limit?.secondary];
		return {
			provider: "Codex",
			account,
			resetCreditsAvailable: usage.resetCreditsAvailable,
			fiveHour: toCodexUsageCell(windows.find((window) => window?.windowMinutes === 300)),
			weekly: toCodexUsageCell(windows.find((window) => window?.windowMinutes === 10_080)),
		};
	} catch (error) {
		return { ...row, status: `error: ${formatUsageError(error)}` };
	}
}

function toCodexUsageCell(window: CodexRateLimitWindow | null | undefined): UsageCell | null {
	return window ? { percent: window.usedPercent, resetsAt: window.resetsAt } : null;
}

async function readClaudeAccountRows(pi: ExtensionAPI): Promise<AccountUsageRow[]> {
	const request: { accounts?: Promise<ClaudeAccountUsage[]> } = {};
	try {
		// The bridge must claim the request synchronously; await its work alongside Codex reads.
		pi.events.emit("claude-bridge:usage-all-request", request);
		if (!request.accounts) return [claudeStatusRow("bridge not loaded")];
		const accounts: unknown = await request.accounts;
		if (!Array.isArray(accounts)) throw new Error("malformed Claude account usage response");
		return accounts.map(formatClaudeAccountRow);
	} catch (error) {
		return [claudeStatusRow(`error: ${formatUsageError(error)}`)];
	}
}

function claudeStatusRow(status: string): AccountUsageRow {
	return { provider: "Claude", account: "", fiveHour: null, weekly: null, status };
}

function formatClaudeAccountRow(value: unknown): AccountUsageRow {
	const account =
		isUsageRecord(value) && typeof value.account === "string" ? sanitizeUsageText(value.account) : "unknown";
	const selected = isUsageRecord(value) && value.selected === true ? " *" : "";
	const row = { provider: "Claude", account: `${account}${selected}`, fiveHour: null, weekly: null };
	if (!isClaudeAccountUsage(value)) return { ...row, status: "error: malformed Claude account usage entry" };
	if ("error" in value) return { ...row, status: `error: ${sanitizeUsageText(value.error)}` };
	return { ...row, fiveHour: toClaudeUsageCell(value.fiveHour), weekly: toClaudeUsageCell(value.weekly) };
}

function isUsageRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function hasClaudeAccountIdentity(value: Record<string, unknown>): boolean {
	if (typeof value.account !== "string") return false;
	return value.account.trim().length > 0 && typeof value.selected === "boolean";
}

function isClaudeAccountUsage(value: unknown): value is ClaudeAccountUsage {
	if (!isUsageRecord(value)) return false;
	if (!hasClaudeAccountIdentity(value)) return false;
	if ("error" in value) return typeof value.error === "string";
	return isUsageWindow(value.fiveHour) && isUsageWindow(value.weekly);
}

function isValidPercent(value: unknown): boolean {
	if (typeof value !== "number") return false;
	return Number.isFinite(value) && value >= 0;
}

function isUtcIsoTimestamp(value: unknown): boolean {
	if (typeof value !== "string") return false;
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function isUsageWindow(value: unknown): value is UsageWindow | null {
	if (value === null) return true;
	if (!isUsageRecord(value)) return false;
	if (!isValidPercent(value.percent)) return false;
	return value.resetsAt === null || isUtcIsoTimestamp(value.resetsAt);
}

function toClaudeUsageCell(window: UsageWindow | null): UsageCell | null {
	if (!window) return null;
	const resetsAt = window.resetsAt === null ? null : Date.parse(window.resetsAt) / 1000;
	return { percent: window.percent, resetsAt };
}

function formatAccountRow(row: AccountUsageRow, accountWidth: number): string {
	const resets = `${formatUsageReset(row.fiveHour)} | ${formatUsageReset(row.weekly)}`;
	const percents = [formatUsagePercent(row.fiveHour), formatUsagePercent(row.weekly)];
	const resetCredits = row.resetCreditsAvailable?.toString() ?? MISSING;
	return formatAccountColumns(
		[...percents, resetCredits, row.provider, row.account, row.status ?? resets],
		accountWidth,
	);
}

/** Percent columns first: fixed width so they line up regardless of account name length. */
function formatAccountColumns(cells: string[], accountWidth: number): string {
	const [fiveHour, weekly, resetCredits, provider, account, details] = cells;
	return [
		fiveHour.padEnd(5),
		weekly.padEnd(5),
		resetCredits.padEnd(6),
		provider.padEnd(8),
		account.padEnd(accountWidth),
		details,
	]
		.join("  ")
		.trimEnd();
}

async function dispatchClaudeUsageRequest(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const request: { args: string; ctx: ExtensionCommandContext; handled?: Promise<void> } = { args, ctx };
	// The bridge listener must assign handled synchronously before emit returns.
	pi.events.emit("claude-bridge:usage-request", request);
	if (!request.handled) {
		ctx.ui.notify("Claude bridge usage handler unavailable.", "error");
		return;
	}
	await request.handled;
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

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readFiniteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readIsoEpochSeconds(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? Math.round(parsed / 1000) : null;
}

function deepseekWindow(percent: unknown, resetsAt: number | null): DeepseekWindow | null {
	const value = readFiniteNumber(percent);
	return value === null ? null : { percent: value, resetsAt };
}

function percentWindow(source: unknown): DeepseekWindow | null {
	const record = asRecord(source);
	return record ? deepseekWindow(record.percent, readIsoEpochSeconds(record.resetsAt)) : null;
}

function formatUsd(value: number): string {
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

export function mapOpenRouterUsage(
	keyPayload: unknown,
	creditsPayload: unknown,
): Pick<DeepseekRow, "week" | "balance"> {
	const key = asRecord(asRecord(keyPayload)?.data);
	const limit = readFiniteNumber(key?.limit);
	const remaining = readFiniteNumber(key?.limit_remaining);
	const resetsAt = readIsoEpochSeconds(asRecord(key?.effective_budget)?.resets_at);
	const week =
		limit !== null && limit > 0 && remaining !== null
			? deepseekWindow(((limit - remaining) / limit) * 100, resetsAt)
			: null;
	const credits = asRecord(asRecord(creditsPayload)?.data);
	const total = readFiniteNumber(credits?.total_credits);
	const used = readFiniteNumber(credits?.total_usage);
	return { week, balance: total !== null && used !== null ? formatUsd(total - used) : null };
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
	const periodEnd =
		typeof subscription?.currentPeriodEnd === "string" ? Date.parse(subscription.currentPeriodEnd) : Number.NaN;

	return {
		day: windowPercent(windows?.fiveHour),
		week: windowPercent(windows?.weekly),
		month:
			allowance !== null && allowance > 0 && monthlyUsed !== null
				? {
						percent: (monthlyUsed / allowance) * 100,
						resetsAt: Number.isFinite(periodEnd) ? Math.round(periodEnd / 1000) : null,
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

function formatDeepseekColumns(cells: string[], balanceWidth: number, providerWidth: number): string {
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

async function fetchUsageJson(url: string, apiKey: string, label: string): Promise<unknown> {
	const response = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` } });
	const text = await response.text();
	if (!response.ok)
		throw new Error(`${label} usage request failed (${response.status}): ${text || response.statusText}`);
	return text ? (JSON.parse(text) as unknown) : {};
}

async function readOpenRouterUsage(apiKey: string): Promise<Pick<DeepseekRow, "week" | "balance">> {
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

async function handleUsageDeepseek(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const rows = await readDeepseekRows(ctx);
	sendUsageReport(ctx, pi, [formatDeepseekReport(rows)], "usage-deepseek");
}

function readDeepseekRows(ctx: ExtensionCommandContext): Promise<DeepseekRow[]> {
	return Promise.all(DEEPSEEK_POOL_PROVIDERS.map((providerId) => readDeepseekRow(ctx, providerId)));
}
