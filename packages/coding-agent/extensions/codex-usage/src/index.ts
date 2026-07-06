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
		description: "Show OpenAI Codex account usage and optionally consume a reset credit",
		getArgumentCompletions: (prefix) => {
			const options = ["reset"];
			const matches = options.filter((option) => option.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const commandArgs = args.trim();
			if (commandArgs === "reset") {
				await handleUsageReset(ctx, pi);
				return;
			}
			if (commandArgs.length > 0) {
				ctx.ui.notify("Usage: /usage [reset]", "warning");
				return;
			}
			await handleUsageRead(ctx, pi);
		},
	});
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
	if (!window) return null;
	const windowSeconds = window.limit_window_seconds;
	const windowMinutes = windowSeconds !== undefined && windowSeconds > 0 ? Math.ceil(windowSeconds / 60) : null;
	return {
		usedPercent: window.used_percent ?? 0,
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
	if (limit.secondary) details.push(`${formatWindowLabel(limit.secondary, "secondary")} ${formatWindow(limit.secondary)}`);
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

async function handleUsageRead(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const usage = await readCodexUsage(ctx);
	pi.sendMessage({ customType: "codex-usage", content: formatCodexUsage(usage), display: true });
}

async function handleUsageReset(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const before = await readCodexUsage(ctx);
	if (before.resetCreditsAvailable <= 0) {
		pi.sendMessage({
			customType: "codex-usage",
			content: `${formatCodexUsage(before)}\n\nNo reset credits available.`,
			display: true,
		});
		return;
	}

	const confirmed = await ctx.ui.confirm(
		"Consume OpenAI Codex reset credit?",
		`This will use 1 of ${before.resetCreditsAvailable} available reset credits.`,
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
	pi.sendMessage({
		customType: "codex-usage",
		content: `${formatResetResponse(payload)}\n\n${formatCodexUsage(after)}`,
		display: true,
	});
}

async function readCodexUsage(ctx: ExtensionCommandContext): Promise<CodexUsage> {
	const token = await getCodexAccessToken(ctx);
	const accountInfo = resolveCodexAccountInfo(token);
	const storedEmail = resolveStoredCodexEmail(ctx);
	const response = await fetch(CODEX_USAGE_URL, { headers: createCodexHeaders(token) });
	return {
		...mapCodexUsagePayload((await decodeJsonResponse(response)) as CodexUsagePayload),
		accountId: accountInfo.accountId,
		email: resolveCodexDisplayEmail(token, storedEmail),
	};
}

function resolveStoredCodexEmail(ctx: ExtensionCommandContext): string | null {
	const credential = ctx.modelRegistry.authStorage.get(resolveCodexProviderId(ctx));
	const email = credential && "email" in credential ? credential.email : undefined;
	return typeof email === "string" && email.length > 0 ? email : null;
}

function resolveCodexProviderId(ctx: ExtensionCommandContext): string {
	const currentModel = ctx.model;
	if (currentModel?.api === CODEX_API_ID) return currentModel.provider;
	return DEFAULT_CODEX_PROVIDER_ID;
}

async function getCodexAccessToken(ctx: ExtensionCommandContext): Promise<string> {
	const providerId = resolveCodexProviderId(ctx);
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
