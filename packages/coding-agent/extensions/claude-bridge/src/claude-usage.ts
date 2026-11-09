import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import { resolveClaudeCodeExecutable } from "./bundled-runtime.ts";
import { prepareAccountProfile, readUsageCredentials } from "./account-profiles.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 5000;
const REQUEST_TIMEOUT_MS = 5000;
const BACKOFF_MS = 250;
const REFRESH_TIMEOUT_MS = 120_000;
// Claude Code refreshes OAuth only on inference; auth status, /usage and mcp list never do.
// Project-only settings from a temp cwd and strict MCP keep user hooks and servers out.
const REFRESH_ARGS = [
	"-p",
	"Reply: ok",
	"--model",
	"haiku",
	"--max-turns",
	"1",
	"--tools",
	"",
	"--no-session-persistence",
	"--setting-sources",
	"project",
	"--strict-mcp-config",
];
const MAX_DATE_TIMESTAMP_MS = 8.64e15;
const WINDOWS = [
	["five_hour", "5-hour", false],
	["seven_day", "7-day", false],
	["seven_day_opus", "7-day Opus", true],
	["seven_day_sonnet", "7-day Sonnet", true],
] as const;

type UsageUI = Pick<ExtensionContext, "ui">;
export interface UsageRequest {
	args: string;
	ctx: UsageUI;
	handled?: Promise<void>;
}
export interface UsageWindow {
	percent: number;
	resetsAt: string | null;
}
export type ClaudeAccountUsage =
	| { account: string; selected: boolean; fiveHour: UsageWindow | null; weekly: UsageWindow | null }
	| { account: string; selected: boolean; error: string };
export interface UsageAllRequest {
	accounts?: Promise<ClaudeAccountUsage[]>;
}
export interface UsageAccount {
	home: string;
	name: string;
	profile?: string;
	configDir?: string;
}
export interface UsageRuntime {
	/** Same executable as SDK queries: configured `pathToClaudeCodeExecutable`, else the SDK's bundled binary. */
	claudeExecutable?: string;
	fetch: typeof globalThis.fetch;
	now: () => number;
	random: () => number;
	sleep: (delay: number) => Promise<void>;
}
class UsageError extends Error {}
export class UsageHttpError extends UsageError {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The SDK's native binary package; queries never depend on `claude` being on PATH. */
function resolveBundledClaude(): string {
	const executable = resolveClaudeCodeExecutable();
	if (executable) return executable;
	try {
		return createRequire(import.meta.url).resolve(
			`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`,
		);
	} catch {
		throw new UsageError(
			`Expired Claude OAuth access token for current account; no bundled Claude binary for ${process.platform}-${process.arch}`,
		);
	}
}

/** Idle accounts are never refreshed by the SDK; let Claude Code refresh and persist the grant. */
async function refreshAccessToken(account: UsageAccount, runtime: UsageRuntime): Promise<boolean> {
	const executable = runtime.claudeExecutable ?? resolveBundledClaude();
	const configDir =
		account.profile === undefined ? account.configDir : prepareAccountProfile(account.home, account.profile);
	try {
		await promisify(execFile)(executable, REFRESH_ARGS, {
			cwd: tmpdir(),
			env: configDir === undefined ? process.env : { ...process.env, CLAUDE_CONFIG_DIR: configDir },
			timeout: REFRESH_TIMEOUT_MS,
		});
		return true;
	} catch {
		// Inference can fail after renewing the grant in the canonical credential file.
		return false;
	}
}

async function readAccessToken(account: UsageAccount, runtime: UsageRuntime): Promise<string> {
	const token = readCurrentAccessToken(account, runtime.now());
	if (token !== undefined) return token;
	const succeeded = await refreshAccessToken(account, runtime);
	const refreshed = readCurrentAccessToken(account, runtime.now());
	if (refreshed === undefined) {
		const failure = succeeded ? "did not renew it" : "failed";
		throw new UsageError(`Expired Claude OAuth access token for current account; claude CLI refresh ${failure}`);
	}
	return refreshed;
}

/** Undefined when the token has expired. */
function readCurrentAccessToken(account: UsageAccount, now: number): string | undefined {
	let credentials: unknown;
	try {
		credentials = readUsageCredentials(account.home, account.profile, account.configDir);
	} catch (error) {
		// The credential reader emits only fixed, sanitized messages.
		throw new UsageError(error instanceof Error ? error.message : "Cannot read Claude credentials");
	}
	const oauth = isRecord(credentials) ? credentials.claudeAiOauth : undefined;
	if (!isRecord(oauth)) throw new UsageError("Missing Claude OAuth access token for current account");
	const token = oauth.accessToken;
	if (typeof token !== "string" || !token.trim()) {
		throw new UsageError("Missing Claude OAuth access token for current account");
	}
	if (oauth.expiresAt !== undefined) {
		if (typeof oauth.expiresAt !== "number" || !Number.isFinite(oauth.expiresAt)) {
			throw new UsageError("Invalid Claude credentials: access token expiry");
		}
		if (oauth.expiresAt <= now) return undefined;
	}
	return token;
}

function retryAfterMs(value: string | null, now: number): number | undefined {
	if (value === null) return undefined;
	const seconds = Number(value);
	if (value.trim() && Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const deadline = Date.parse(value);
	return Number.isFinite(deadline) ? Math.max(0, deadline - now) : undefined;
}

function httpUsageError(status: number, delay: number | undefined, now: number): UsageError {
	if (status === 401) return new UsageError("Claude usage HTTP 401: current account OAuth token expired or rejected");
	// Inference-only tokens (`claude setup-token`) lack the user:profile scope this endpoint requires.
	if (status === 403)
		return new UsageError(
			"Claude usage HTTP 403: token not authorized to read usage (inference-only setup-token? full `claude auth login` grants user:profile)",
		);
	const retry = delay === undefined ? "" : `; retry after ${Math.ceil(delay / 1000)} seconds`;
	const deadline =
		delay !== undefined && delay <= MAX_DATE_TIMESTAMP_MS - now ? ` (${new Date(now + delay).toISOString()})` : "";
	return new UsageHttpError(status, `Claude usage HTTP ${status}${retry}${deadline}`);
}

async function fetchUsageResponse(token: string, runtime: UsageRuntime): Promise<Response | undefined> {
	try {
		return await runtime.fetch(USAGE_URL, {
			headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch {
		// The caller handles network failure with bounded retries and a sanitized error.
		return undefined;
	}
}

async function fetchSubscriptionUsage(token: string, runtime: UsageRuntime): Promise<unknown> {
	const waitDeadline = runtime.now() + MAX_WAIT_MS;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const backoff = BACKOFF_MS * 2 ** attempt * (1 + runtime.random());
		const response = await fetchUsageResponse(token, runtime);
		if (response?.ok) return readUsageResponse(response);
		const now = runtime.now();
		const delay = response ? retryAfterMs(response.headers.get("Retry-After"), now) : undefined;
		const failure = response
			? httpUsageError(response.status, delay, now)
			: new UsageError("Claude usage network request failed after bounded attempts");
		const isServerError = response !== undefined && response.status >= 500 && response.status <= 599;
		const isTransient = response === undefined || response.status === 429 || isServerError;
		const wait = Math.max(backoff, delay ?? 0);
		const hasTime = now + wait <= waitDeadline;
		const hasAttempts = attempt + 1 < MAX_ATTEMPTS;
		const canRetry = isTransient && hasTime && hasAttempts;
		if (!canRetry) throw failure;
		await runtime.sleep(wait);
	}
	throw new UsageError("Claude usage request failed");
}

async function readUsageResponse(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new UsageError("Invalid Claude usage response: expected JSON subscription windows");
	}
}

function readWindowUtilization(value: unknown): number {
	if (!isRecord(value)) throw new UsageError("Invalid Claude usage response: expected subscription window");
	const percent = value.utilization;
	const validPercent = typeof percent === "number" && Number.isFinite(percent) && percent >= 0 && percent <= 100;
	if (!validPercent) throw new UsageError("Invalid Claude usage response: invalid percent");
	return percent;
}

function renderWindow(value: unknown, label: string): string {
	if (value === null) return `${label}: unavailable`;
	const percent = readWindowUtilization(value);
	const reset = isRecord(value) ? value.resets_at : undefined;
	return `${label}: ${percent}% — ${renderReset(reset)}`;
}

function readReset(reset: unknown): string | null {
	if (reset === null) return null;
	const isoWithTimezone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
	if (typeof reset !== "string" || !isoWithTimezone.test(reset)) {
		throw new UsageError("Invalid Claude usage response: invalid reset");
	}
	const deadline = Date.parse(reset);
	if (!Number.isFinite(deadline)) throw new UsageError("Invalid Claude usage response: invalid reset");
	return new Date(deadline).toISOString();
}

function renderReset(reset: unknown): string {
	const resetsAt = readReset(reset);
	return resetsAt === null ? "reset unavailable" : `resets ${resetsAt} (UTC)`;
}

function readUsageWindow(value: unknown): UsageWindow | null {
	if (value === null) return null;
	const percent = readWindowUtilization(value);
	const resetsAt = readReset(isRecord(value) ? value.resets_at : undefined);
	return { percent, resetsAt };
}

async function readAccountUsage(
	account: UsageAccount,
	selectedName: string | undefined,
	runtime: UsageRuntime,
): Promise<ClaudeAccountUsage> {
	const identity = { account: account.name, selected: account.name === selectedName };
	try {
		const token = await readAccessToken(account, runtime);
		const response = await fetchSubscriptionUsage(token, runtime);
		if (!isRecord(response)) throw new UsageError("Invalid Claude usage response: expected subscription windows");
		return {
			...identity,
			fiveHour: readUsageWindow(response.five_hour),
			weekly: readUsageWindow(response.seven_day),
		};
	} catch (error) {
		const message = error instanceof UsageError ? error.message : "Cannot read Claude account for subscription usage";
		return { ...identity, error: message };
	}
}

export async function readAllClaudeUsage(
	accounts: readonly UsageAccount[],
	selectedName: string | undefined,
	overrides: Partial<UsageRuntime> = {},
): Promise<ClaudeAccountUsage[]> {
	const runtime = createUsageRuntime(overrides);
	const results: ClaudeAccountUsage[] = [];
	// Await each account: this endpoint aggressively rate-limits concurrent requests.
	for (const account of accounts) {
		results.push(await readAccountUsage(account, selectedName, runtime));
	}
	return results;
}

function renderSubscriptionUsage(name: string, response: unknown): string {
	if (!isRecord(response)) throw new UsageError("Invalid Claude usage response: expected subscription windows");
	const windows = WINDOWS.map(([field, label, optional]) => {
		const isAbsentOptional = optional && !Object.hasOwn(response, field);
		return renderWindow(isAbsentOptional ? null : response[field], label);
	});
	return [`Claude account: ${name}`, "Subscription quota (not session token usage)", ...windows].join("\n");
}

function createUsageRuntime(overrides: Partial<UsageRuntime>): UsageRuntime {
	return {
		fetch: globalThis.fetch,
		now: Date.now,
		random: Math.random,
		sleep: (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
		...overrides,
	};
}

const MODEL_WINDOWS = [
	["opus", "seven_day_opus"],
	["sonnet", "seven_day_sonnet"],
] as const;

function hasSubscriptionCapacity(response: unknown, modelId: string): boolean {
	if (!isRecord(response)) throw new UsageError("Invalid Claude usage response: expected subscription windows");
	const percentages = [readWindowUtilization(response.five_hour), readWindowUtilization(response.seven_day)];
	for (const [model, field] of MODEL_WINDOWS) {
		const window = response[field];
		if (modelId.includes(model) && window !== undefined && window !== null) {
			percentages.push(readWindowUtilization(window));
		}
	}
	return percentages.every((percent) => percent < 100);
}

export async function readClaudeSubscriptionCapacity(
	account: UsageAccount,
	modelId: string,
	overrides: Partial<UsageRuntime> = {},
): Promise<boolean> {
	const runtime = createUsageRuntime(overrides);
	const token = await readAccessToken(account, runtime);
	const response = await fetchSubscriptionUsage(token, runtime);
	return hasSubscriptionCapacity(response, modelId);
}

export async function reportClaudeUsage(
	args: string,
	ctx: UsageUI,
	readAccount: () => UsageAccount | undefined,
	sendReport: (report: string) => void,
	overrides: Partial<UsageRuntime> = {},
): Promise<void> {
	if (typeof args !== "string" || args.trim()) {
		ctx.ui.notify(
			"Unsupported /usage arguments for Claude; use /usage without arguments. Claude quota reset is unsupported.",
			"warning",
		);
		return;
	}
	const runtime = createUsageRuntime(overrides);
	try {
		const account = readAccount();
		if (account === undefined)
			throw new UsageError("No selected Claude account profile available for subscription usage");
		const token = await readAccessToken(account, runtime);
		const response = await fetchSubscriptionUsage(token, runtime);
		sendReport(renderSubscriptionUsage(account.name, response));
	} catch (error) {
		const message =
			error instanceof UsageError ? error.message : "Cannot read Claude current account for subscription usage";
		ctx.ui.notify(message, "error");
	}
}
