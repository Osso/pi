import { CODEX_FALLBACK_PROVIDERS } from "../../../src/core/codex-quota-fallback.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../../src/core/extensions/types.ts";

const DEFAULT_CODEX_PROVIDER_ID = "openai-codex";
const CODEX_API_ID = "openai-codex-responses";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESET_CREDIT_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
const ACCOUNT_ID_CLAIM = "https://api.openai.com/auth";

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
	rate_limit_reset_credits?: { available_count?: number } | null;
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
	resetCreditsAvailable: number;
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
		resetCreditsAvailable: payload.rate_limit_reset_credits?.available_count ?? 0,
		limits,
	};
}

export function formatCodexUsage(usage: CodexUsage): string {
	const lines = ["OpenAI Codex usage"];
	if (usage.email) lines.push(`User: ${usage.email}`);
	if (usage.accountId) lines.push(`Account: ${usage.accountId}`);
	lines.push(`Plan: ${usage.planType ?? "unknown"}`);
	lines.push(`Reset credits: ${usage.resetCreditsAvailable} available`);

	for (const limit of usage.limits) {
		lines.push(formatLimit(limit));
	}

	return lines.join("\n");
}

export default function codexUsageExtension(pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: "Show Codex or Claude usage, all accounts, or reset Codex usage",
		getArgumentCompletions: (prefix) => {
			const options = ["all", "reset"];
			const matches = options.filter((option) => option.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const commandArgs = args.trim();
			if (commandArgs === "all") {
				await handleUsageAll(ctx, pi);
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
				ctx.ui.notify("Usage: /usage [all|reset]", "warning");
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
	/** Error or login state; replaces the reset details. */
	status?: string;
}

const MISSING = "-";

async function handleUsageAll(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const [claudeRows, codexRows] = await Promise.all([
		readClaudeAccountRows(pi),
		Promise.all([...CODEX_FALLBACK_PROVIDERS.keys()].map((id) => readCodexAccountRow(ctx, id))),
	]);
	const rows = [...claudeRows, ...codexRows];
	const accountWidth = Math.max("Account".length, ...rows.map((row) => row.account.length));
	const header = ["5h", "Week", "Provider", "Account", "Resets UTC (5h | week)"];
	const content = [
		`Account usage (all accounts); ${MISSING} = not reported`,
		formatAccountColumns(header, accountWidth),
		...rows.map((row) => formatAccountRow(row, accountWidth)),
	].join("\n");
	sendCodexUsageReport(ctx, pi, content, "usage-all");
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
	return formatAccountColumns([...percents, row.provider, row.account, row.status ?? resets], accountWidth);
}

/** Percent columns first: fixed width so they line up regardless of account name length. */
function formatAccountColumns(cells: string[], accountWidth: number): string {
	const [fiveHour, weekly, provider, account, details] = cells;
	return [fiveHour.padEnd(5), weekly.padEnd(5), provider.padEnd(8), account.padEnd(accountWidth), details]
		.join("  ")
		.trimEnd();
}

function formatUsagePercent(cell: UsageCell | null): string {
	return cell ? formatPercent(cell.percent) : MISSING;
}

function formatUsageReset(cell: UsageCell | null): string {
	return cell?.resetsAt == null ? MISSING : formatResetTime(cell.resetsAt);
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
): void {
	const message = { customType, content, display: true };
	if (!ctx.isIdle()) {
		ctx.ui.notify(content, "info");
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
	if (before.resetCreditsAvailable <= 0) {
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
