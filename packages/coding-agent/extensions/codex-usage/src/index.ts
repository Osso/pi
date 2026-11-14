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
import {
	asRecord,
	type DeepseekRow,
	fetchUsageJson,
	formatDeepseekReport,
	formatUsd,
	readDeepseekRows,
	readFiniteNumber,
} from "./deepseek-usage.ts";

export {
	DeepseekRow,
	DeepseekWindow,
	formatDeepseekUsage,
	mapCommandCodeUsage,
	mapDeepseekBalance,
	mapOpencodeGoUsage,
	mapOpenGroveUsage,
	mapOpenRouterUsage,
} from "./deepseek-usage.ts";

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

async function handleUsageDeepseek(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const rows = await readDeepseekRows(ctx);
	sendUsageReport(ctx, pi, [formatDeepseekReport(rows)], "usage-deepseek");
}
