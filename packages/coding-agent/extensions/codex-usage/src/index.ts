import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "../../../src/config.ts";
import { CODEX_FALLBACK_PROVIDERS } from "../../../src/core/codex-quota-fallback.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../../src/core/extensions/types.ts";

const DEFAULT_CODEX_PROVIDER_ID = "openai-codex";
const CODEX_API_ID = "openai-codex-responses";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESET_CREDIT_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
const ACCOUNT_ID_CLAIM = "https://api.openai.com/auth";
const OPENAI_PLATFORM_BASE = "https://api.openai.com/v1";

type NullableBox<T> = T | null | undefined;

type CodexTokenPayload = {
	email?: unknown;
	profile?: { email?: unknown };
	[ACCOUNT_ID_CLAIM]?: { chatgpt_account_id?: unknown };
};

export interface CodexRateLimitWindowPayload {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_at?: number;
}

export interface CodexRateLimitDetailsPayload {
	primary_window?: NullableBox<CodexRateLimitWindowPayload>;
	secondary_window?: NullableBox<CodexRateLimitWindowPayload>;
}

export interface CodexCreditsPayload {
	has_credits?: boolean;
	unlimited?: boolean;
	balance?: string | null;
}

export interface CodexAdditionalRateLimitPayload {
	limit_name?: string;
	metered_feature?: string;
	rate_limit?: NullableBox<CodexRateLimitDetailsPayload>;
}

export interface CodexUsagePayload {
	plan_type?: string;
	rate_limit?: NullableBox<CodexRateLimitDetailsPayload>;
	additional_rate_limits?: NullableBox<CodexAdditionalRateLimitPayload[]>;
	credits?: NullableBox<CodexCreditsPayload>;
	rate_limit_reset_credits?: { available_count?: number | null } | null;
}

export interface CodexRateLimitWindow {
	usedPercent: number;
	windowMinutes: number | null;
	resetsAt: number | null;
}

export interface CodexCredits {
	hasCredits: boolean;
	unlimited: boolean;
	balance: string | null;
}

export interface CodexRateLimit {
	limitId: string;
	limitName: string | null;
	primary: CodexRateLimitWindow | null;
	secondary: CodexRateLimitWindow | null;
	credits: CodexCredits | null;
}

export interface CodexUsage {
	planType: string | null;
	accountId: string | null;
	email: string | null;
	resetCreditsAvailable: number | null;
	limits: CodexRateLimit[];
}

interface ConsumeResetCreditResponse {
	code?: "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed";
	windows_reset?: number;
}

export interface CodexAccountInfo {
	accountId: string;
	email: string | null;
}

export function resolveCodexAccountId(token: string): string {
	return resolveCodexAccountInfo(token).accountId;
}

export function resolveCodexAccountInfo(token: string): CodexAccountInfo {
	const payload = decodeCodexTokenPayload(token);
	const accountId = payload[ACCOUNT_ID_CLAIM]?.chatgpt_account_id;
	if (typeof accountId !== "string" || accountId.length === 0) {
		throw new Error("OpenAI Codex access token does not include a ChatGPT account id");
	}
	return { accountId, email: resolveEmailClaim(payload) };
}

export function resolveCodexDisplayEmail(token: string, storedEmail: unknown): string | null {
	if (typeof storedEmail === "string" && storedEmail.length > 0) return storedEmail;
	return resolveCodexAccountInfo(token).email;
}

function decodeCodexTokenPayload(token: string): CodexTokenPayload {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("Invalid OpenAI Codex access token");
	return JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as CodexTokenPayload;
}

export function mapCodexUsagePayload(payload: CodexUsagePayload): CodexUsage {
	const limits = [
		mapCodexRateLimit("codex", null, payload.rate_limit, payload.credits),
		...mapAdditionalRateLimits(payload.additional_rate_limits),
	];

	return {
		planType: payload.plan_type ?? null,
		accountId: null,
		email: null,
		resetCreditsAvailable: payload.rate_limit_reset_credits?.available_count ?? null,
		limits,
	};
}

export function formatCodexUsage(usage: CodexUsage): string {
	const lines = ["OpenAI Codex usage"];
	if (usage.email) lines.push(`User: ${usage.email}`);
	if (usage.accountId) lines.push(`Account: ${usage.accountId}`);
	lines.push(`Plan: ${usage.planType ?? "unknown"}`);
	lines.push(`Reset credits: ${usage.resetCreditsAvailable ?? 0} available`);

	for (const limit of usage.limits) {
		lines.push(formatLimit(limit));
	}

	return lines.join("\n");
}

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

interface UsageCell {
	percent: number;
	/** Epoch seconds. */
	resetsAt: number | null;
}

interface AccountUsageRow {
	provider: string;
	account: string;
	fiveHour: UsageCell | null;
	weekly: UsageCell | null;
	/** Available reset credits, absent when not reported. */
	resetCreditsAvailable?: number | null;
	/** Error or login state; replaces the reset details. */
	status?: string;
}

const MISSING = "-";
const RESET_CREDITS_LEGEND = `Resets = available reset credits; ${MISSING} = not reported`;
const SCOPE_TITLES = {
	all: "Account usage (all accounts)",
	claude: "Claude account usage",
	openai: "OpenAI account usage",
} as const;
const CENTRAL_RESET_FORMAT = new Intl.DateTimeFormat("sv-SE", {
	timeZone: "America/Chicago",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
});

type UsageScope = "all" | "claude" | "openai";

interface UsageSection {
	title: string;
	table: string;
}

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
	let account = providerId;
	try {
		const apiKey = await ctx.modelRegistry.authStorage.getApiKey(providerId, { includeFallback: false });
		if (!apiKey) return { ...row, status: "not logged in" };
		account = sanitizeUsageText((await readOpenAiAccountEmail(apiKey)) ?? providerId);
		const adminKeyPath = openAiAdminKeyPath(providerId);
		const adminKey = await readOptionalText(adminKeyPath);
		if (!adminKey) return { ...row, account, status: `no admin key: ${adminKeyPath}` };
		const spend = await readOpenAiSpend(adminKey);
		return { ...row, account, today: formatUsd(spend.today), month: formatUsd(spend.month) };
	} catch (error) {
		return { ...row, account, status: `error: ${formatUsageError(error)}` };
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

async function readOpenAiSpend(adminKey: string): Promise<{ today: number; month: number }> {
	const now = new Date();
	const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
	const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	const query = new URLSearchParams({
		start_time: String(Math.floor(monthStart / 1000)),
		bucket_width: "1d",
		limit: "31",
	});
	const url = `${OPENAI_PLATFORM_BASE}/organization/costs?${query.toString()}`;
	const buckets = asRecord(await fetchUsageJson(url, adminKey, "OpenAI API costs"))?.data;
	if (!Array.isArray(buckets)) throw new Error("OpenAI API costs response has no buckets");
	let today = 0;
	let month = 0;
	for (const bucket of buckets) {
		const amount = sumCostAmounts(asRecord(bucket)?.results);
		month += amount;
		const bucketStartMs = (readFiniteNumber(asRecord(bucket)?.start_time) ?? 0) * 1000;
		if (bucketStartMs >= todayStart) today += amount;
	}
	return { today, month };
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
	const lines = [formatPlatformColumns(["Today", "Month", "Provider", "Account", "Status"], providerWidth, accountWidth)];
	for (const row of rows) {
		const cells = [row.today ?? MISSING, row.month ?? MISSING, row.provider, row.account, row.status ?? ""];
		lines.push(formatPlatformColumns(cells, providerWidth, accountWidth));
	}
	return { title: OPENAI_PLATFORM_TITLE, table: lines.join("\n") };
}

function formatPlatformColumns(cells: string[], providerWidth: number, accountWidth: number): string {
	const [today, month, provider, account, status] = cells;
	return [today.padEnd(8), month.padEnd(8), provider.padEnd(providerWidth), account.padEnd(accountWidth), status]
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
	return formatAccountColumns([...percents, resetCredits, row.provider, row.account, row.status ?? resets], accountWidth);
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

function formatUsagePercent(cell: UsageCell | null): string {
	return cell ? formatPercent(cell.percent) : MISSING;
}

function formatUsageReset(cell: UsageCell | null): string {
	if (cell?.resetsAt == null) return MISSING;
	const date = new Date(cell.resetsAt * 1000);
	return Number.isNaN(date.getTime()) ? "unknown" : CENTRAL_RESET_FORMAT.format(date);
}

function formatUsageError(error: unknown): string {
	return sanitizeUsageText(error instanceof Error ? error.message : String(error));
}

function sanitizeUsageText(value: string): string {
	return value
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]")
		.replace(/\b(?:sk-|sk-ant-)[A-Za-z0-9_-]+/g, "[redacted]")
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.slice(0, 300);
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

function resolveEmailClaim(payload: CodexTokenPayload): string | null {
	if (typeof payload.email === "string" && payload.email.length > 0) return payload.email;
	const profileEmail = payload.profile?.email;
	return typeof profileEmail === "string" && profileEmail.length > 0 ? profileEmail : null;
}

function mapAdditionalRateLimits(payloads: NullableBox<CodexAdditionalRateLimitPayload[]>): CodexRateLimit[] {
	return (payloads ?? []).map((payload) =>
		mapCodexRateLimit(
			payload.metered_feature || payload.limit_name || "codex_other",
			payload.limit_name ?? payload.metered_feature ?? null,
			payload.rate_limit,
			null,
		),
	);
}

function mapCodexRateLimit(
	limitId: string,
	limitName: string | null,
	rateLimit: NullableBox<CodexRateLimitDetailsPayload>,
	credits: NullableBox<CodexCreditsPayload>,
): CodexRateLimit {
	return {
		limitId,
		limitName,
		primary: mapWindow(rateLimit?.primary_window),
		secondary: mapWindow(rateLimit?.secondary_window),
		credits: mapCredits(credits),
	};
}

function mapWindow(window: NullableBox<CodexRateLimitWindowPayload>): CodexRateLimitWindow | null {
	if (typeof window?.used_percent !== "number" || !Number.isFinite(window.used_percent)) return null;
	const windowSeconds = window.limit_window_seconds;
	const windowMinutes = windowSeconds !== undefined && windowSeconds > 0 ? Math.ceil(windowSeconds / 60) : null;
	return {
		usedPercent: window.used_percent,
		windowMinutes,
		resetsAt: window.reset_at ?? null,
	};
}

function mapCredits(credits: NullableBox<CodexCreditsPayload>): CodexCredits | null {
	if (!credits) return null;
	return {
		hasCredits: credits.has_credits ?? false,
		unlimited: credits.unlimited ?? false,
		balance: credits.balance ?? null,
	};
}

function formatLimit(limit: CodexRateLimit): string {
	const label = limit.limitName ? `${limit.limitId} (${limit.limitName})` : limit.limitId;
	const details = formatLimitDetails(limit).map((detail) => `${label}: ${detail}`);
	return details.length > 0 ? details.join("\n") : `${label}: no limit data`;
}

function formatLimitDetails(limit: CodexRateLimit): string[] {
	const details: string[] = [];
	if (limit.primary) details.push(`${formatWindowLabel(limit.primary, "primary")} ${formatWindow(limit.primary)}`);
	if (limit.secondary)
		details.push(`${formatWindowLabel(limit.secondary, "secondary")} ${formatWindow(limit.secondary)}`);
	if (limit.credits) details.push(formatCredits(limit.credits));
	return details;
}

function formatWindowLabel(window: CodexRateLimitWindow, fallback: "primary" | "secondary"): string {
	if (window.windowMinutes === 300) return "5-hour usage";
	if (window.windowMinutes === 10_080) return "weekly usage";
	return fallback;
}

function formatWindow(window: CodexRateLimitWindow): string {
	const windowText = window.windowMinutes === null ? "window" : `${window.windowMinutes}m window`;
	const resetText = window.resetsAt === null ? "unknown" : formatResetTime(window.resetsAt);
	return `${formatPercent(window.usedPercent)} of ${windowText} resets ${resetText}`;
}

function formatPercent(value: number): string {
	return Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`;
}

function formatResetTime(timestampSeconds: number): string {
	const date = new Date(timestampSeconds * 1000);
	if (Number.isNaN(date.getTime())) return "unknown";
	const datePart = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
	return `${datePart} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function formatCredits(credits: CodexCredits): string {
	if (credits.unlimited) return "credits unlimited";
	if (credits.balance) return `credits balance ${credits.balance}`;
	return credits.hasCredits ? "credits available" : "credits unavailable";
}

function pad(value: number): string {
	return value.toString().padStart(2, "0");
}

function sendCodexUsageReport(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	content: string,
	customType = "codex-usage",
	notification = content,
): void {
	const message = { customType, content, display: true };
	if (!ctx.isIdle()) {
		ctx.ui.notify(notification, "info");
		pi.sendMessage(message, { deliverAs: "nextTurn" });
		return;
	}
	pi.sendMessage(message);
}

async function handleUsageRead(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const usage = await readCodexUsage(ctx);
	sendCodexUsageReport(ctx, pi, formatCodexUsage(usage));
}

async function handleUsageReset(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const before = await readCodexUsage(ctx);
	if ((before.resetCreditsAvailable ?? 0) <= 0) {
		sendCodexUsageReport(ctx, pi, `${formatCodexUsage(before)}\n\nNo reset credits available.`);
		return;
	}

	const confirmed = await ctx.ui.confirm(
		"Are you sure you want to reset OpenAI Codex usage?",
		`This will consume 1 of ${before.resetCreditsAvailable} available reset credits.`,
	);
	if (!confirmed) return;

	const token = await getCodexAccessToken(ctx);
	const response = await fetch(CODEX_RESET_CREDIT_URL, {
		method: "POST",
		headers: createCodexHeaders(token, { "content-type": "application/json" }),
		body: JSON.stringify({ redeem_request_id: createRedeemRequestId() }),
	});
	const payload = (await decodeJsonResponse(response)) as ConsumeResetCreditResponse;
	const after = await readCodexUsage(ctx);
	sendCodexUsageReport(ctx, pi, `${formatResetResponse(payload)}\n\n${formatCodexUsage(after)}`);
}

async function readCodexUsage(
	ctx: ExtensionCommandContext,
	providerId = resolveCodexProviderId(ctx),
): Promise<CodexUsage> {
	const token = await getCodexAccessToken(ctx, providerId);
	try {
		const accountInfo = resolveCodexAccountInfo(token);
		const storedEmail = resolveStoredCodexEmail(ctx, providerId);
		const response = await fetch(CODEX_USAGE_URL, { headers: createCodexHeaders(token) });
		return {
			...mapCodexUsagePayload((await decodeJsonResponse(response)) as CodexUsagePayload),
			accountId: accountInfo.accountId,
			email: resolveCodexDisplayEmail(token, storedEmail),
		};
	} catch (error) {
		// An upstream error body may echo the request credentials.
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(message.replaceAll(token, "[redacted]"));
	}
}

function resolveStoredCodexEmail(ctx: ExtensionCommandContext, providerId: string): string | null {
	const credential = ctx.modelRegistry.authStorage.get(providerId);
	const email = credential && "email" in credential ? credential.email : undefined;
	return typeof email === "string" && email.length > 0 ? email : null;
}

function resolveCodexProviderId(ctx: ExtensionCommandContext): string {
	const currentModel = ctx.model;
	if (currentModel?.api === CODEX_API_ID) return currentModel.provider;
	return DEFAULT_CODEX_PROVIDER_ID;
}

async function getCodexAccessToken(
	ctx: ExtensionCommandContext,
	providerId = resolveCodexProviderId(ctx),
): Promise<string> {
	const token = await ctx.modelRegistry.authStorage.getApiKey(providerId, { includeFallback: false });
	if (!token) throw new Error(`OpenAI Codex provider ${providerId} is not logged in. Run /login ${providerId}.`);
	return token;
}

function createCodexHeaders(token: string, extraHeaders: Record<string, string> = {}): Headers {
	const headers = new Headers(extraHeaders);
	headers.set("authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", resolveCodexAccountId(token));
	headers.set("originator", "pi");
	headers.set("user-agent", "pi");
	return headers;
}

async function decodeJsonResponse(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`OpenAI Codex usage request failed (${response.status}): ${text || response.statusText}`);
	}
	if (!text) return {};
	return JSON.parse(text) as unknown;
}

function createRedeemRequestId(): string {
	if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
	return `pi_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function formatResetResponse(response: ConsumeResetCreditResponse): string {
	switch (response.code) {
		case "reset":
			return `Consumed reset credit. Windows reset: ${response.windows_reset ?? 0}`;
		case "nothing_to_reset":
			return "No active Codex rate-limit window needed a reset.";
		case "no_credit":
			return "No reset credit available.";
		case "already_redeemed":
			return "Reset credit was already redeemed.";
		default:
			return "Reset credit response received.";
	}
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
	const week = limit !== null && limit > 0 && remaining !== null
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
	const periodEnd = typeof subscription?.currentPeriodEnd === "string" ? Date.parse(subscription.currentPeriodEnd) : Number.NaN;

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
	const lines = [formatDeepseekColumns(["Day", "Week", "Month", "Balance", "Provider", "Resets Central (day | week | month)"], balanceWidth, providerWidth)];
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
	if (!response.ok) throw new Error(`${label} usage request failed (${response.status}): ${text || response.statusText}`);
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
	const summary = await fetchJson(
		`/alpha/usage/summary${summaryQuery.size > 0 ? `?${summaryQuery.toString()}` : ""}`,
	);
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
