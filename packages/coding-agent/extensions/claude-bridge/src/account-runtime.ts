import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Api, AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import {
	InvalidCredentialsError,
	prepareAccountProfile,
	readAccountState,
	updateAccountState,
	validateAccountProfileNames,
} from "./account-profiles.ts";
import { recheckAccountProfiles } from "./account-recheck.ts";
import {
	type ClaudeAccountUsage,
	readAllClaudeUsage,
	reportClaudeUsage,
	type UsageAccount,
	type UsageAllRequest,
	type UsageRequest,
	type UsageRuntime,
} from "./claude-usage.ts";
import type { Config } from "./config.ts";
import { debug } from "./diagnostics.ts";
import { ACCOUNTS_EXHAUSTED, AccountProfileManager, newAssistantOutput, type QueryContext } from "./query-state.ts";
import { type SdkUsage, updateUsage } from "./usage.ts";

export let providerSettings: NonNullable<Config["provider"]> = {};
export let claudeExecutable: string | undefined;
let accountProfileManager: AccountProfileManager | undefined;

export function configureAccountRuntime(
	settings: NonNullable<Config["provider"]>,
	executable: string | undefined,
): void {
	providerSettings = settings;
	claudeExecutable = executable;
}

export function resetAccountProfiles(): void {
	accountProfileManager = undefined;
}

function readActiveAccountProfile(home: string, configDir = join(home, ".claude")): string | undefined {
	try {
		return readFileSync(join(configDir, ".active-profile"), "utf8").trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error("Cannot read Claude active profile marker");
	}
}

function readCurrentUsageAccount(): UsageAccount | undefined {
	const home = homedir();
	const names = providerSettings.accountProfiles;
	if (names === undefined) {
		const configDir = process.env.CLAUDE_CONFIG_DIR;
		const active = readActiveAccountProfile(home, configDir ?? join(home, ".claude"));
		return { home, name: active || "current", configDir };
	}
	if (!Array.isArray(names)) throw new Error("Invalid Claude account profiles configuration");
	const name = accountProfileManager
		? accountProfileManager.selectedProfile
		: createAccountProfileManager(names, home).selectedProfile;
	return name === undefined ? undefined : { home, name, profile: name };
}

async function readConfiguredClaudeUsage(): Promise<ClaudeAccountUsage[]> {
	const names = providerSettings.accountProfiles;
	if (names !== undefined) {
		if (!Array.isArray(names)) throw new Error("Invalid Claude account profiles configuration");
		validateAccountProfileNames(names);
	}
	const current = readCurrentUsageAccount();
	if (names === undefined) {
		if (current === undefined) throw new Error("No selected Claude account profile");
		return readAllClaudeUsage([current], current.name, usageRuntime());
	}
	const home = homedir();
	return readAllClaudeUsage(
		names.map((name) => ({ home, name, profile: name })),
		current?.name,
		usageRuntime(),
	);
}

/** Token refresh runs the same Claude executable as SDK queries. */
function usageRuntime(): Partial<UsageRuntime> {
	return claudeExecutable ? { claudeExecutable } : {};
}

function createAccountProfileManager(names: readonly string[], home: string): AccountProfileManager {
	return new AccountProfileManager(names, readActiveAccountProfile(home), {
		read: () => readAccountState(home),
		update: (change) => updateAccountState(home, change),
	});
}

export function prepareProviderAccount() {
	const names = providerSettings.accountProfiles;
	if (names === undefined) return undefined;
	if (!Array.isArray(names)) throw new Error("provider.accountProfiles must be an ordered list of profile names");
	const home = homedir();
	if (!accountProfileManager) {
		accountProfileManager = createAccountProfileManager(names, home);
	}
	const manager = accountProfileManager;
	let name = manager.select(Date.now() / 1000);
	for (;;) {
		if (name === undefined) throw new Error(ACCOUNTS_EXHAUSTED);
		try {
			return { home, name, manager, configDir: prepareAccountProfile(home, name) };
		} catch (error) {
			if (!(error instanceof InvalidCredentialsError)) throw error;
			// Blocked without a reset time: only a live recheck after a new login brings it back.
			debug(`provider: ${name} has no usable credentials (${error.message}); using the next account`);
			name = manager.reject(name, undefined, Date.now() / 1000);
		}
	}
}

export async function fetchAccountRetryProfiles(model: Model<Api>, signal?: AbortSignal) {
	const names = providerSettings.accountProfiles;
	if (!names || !accountProfileManager) throw new Error(ACCOUNTS_EXHAUSTED);
	return recheckAccountProfiles(accountProfileManager, names, homedir(), model.id, signal, usageRuntime());
}

// SDKRateLimitInfo subscription windows; overage/credit gates do not exhaust accounts.
const SUBSCRIPTION_QUOTA_WINDOWS = new Set([
	"five_hour",
	"seven_day",
	"seven_day_opus",
	"seven_day_sonnet",
	"seven_day_overage_included",
]);

function isSubscriptionQuotaRejection(rejection: NonNullable<QueryContext["rateLimitRejection"]>): boolean {
	return rejection.errorCode !== "credits_required" && SUBSCRIPTION_QUOTA_WINDOWS.has(rejection.rateLimitType ?? "");
}

export function classifyAccountFailure(
	failure: string,
	rejection: QueryContext["rateLimitRejection"] | undefined,
): QueryContext["quotaFailure"] {
	if (
		failure ===
		"Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access"
	)
		return {};
	return rejection && isSubscriptionQuotaRejection(rejection) ? rejection : null;
}

export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err && typeof err === "object") {
		const obj = err as Record<string, unknown>;
		if (typeof obj.message === "string") return obj.message;
		if (typeof obj.error === "string") return obj.error;
		try {
			return JSON.stringify(err);
		} catch {}
	}
	return String(err);
}

export function emitAccountPreparationFailure(
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	error: unknown,
	aborted = false,
): void {
	const reason = aborted ? "aborted" : "error";
	const output = newAssistantOutput(model, "", reason, errorMessage(error));
	queueMicrotask(() => {
		stream.push({ type: "error", reason, error: output });
		markStreamComplete(stream);
		stream.end();
	});
}

export const completedStreams = new WeakSet<object>();

export function markStreamComplete(stream: AssistantMessageEventStream | null): void {
	if (stream) completedStreams.add(stream as object);
}

// The counter mapping lives in usage.ts; the debug line is this side's job, so every
// call site logs the same way rather than three times over.
export function recordUsage(output: AssistantMessage, usage: SdkUsage, model: Model<Api>): void {
	const { cachePct, reasoning } = updateUsage(output, usage, model);
	const reasoningText = reasoning == null ? "" : ` reasoning=${reasoning}`;
	debug(
		`usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens}${reasoningText} cachePct=${cachePct}% model=${model.id}`,
	);
}

// Log the *served* context window reported by an SDK result message
// (modelUsage[id].contextWindow), which can differ from the window pi
// registered (model.contextWindow) when the runtime entitlement doesn't
// match the docs — e.g. bare Opus served 200K on Pro, or [1m] not honored.
// The result message's modelUsage is otherwise discarded; this makes the
// gap observable. See issue #18.
export function logServedContextWindow(label: string, message: SDKMessage, model: Model<Api>): void {
	if (message.type !== "result") return;
	const modelUsage = message.modelUsage;
	if (!modelUsage) return;
	for (const [k, v] of Object.entries(modelUsage)) {
		debug(
			`${label}: served contextWindow=${v.contextWindow ?? "?"} maxOutputTokens=${v.maxOutputTokens ?? "?"} servedModel=${k} registered=${model.contextWindow}`,
		);
	}
}

export function registerClaudeUsageListener(pi: ExtensionAPI): void {
	const unsubscribeUsage = pi.events.on("claude-bridge:usage-request", (payload) => {
		const request = payload as UsageRequest;
		if (request.handled !== undefined) return;
		request.handled = reportClaudeUsage(
			request.args,
			request.ctx,
			readCurrentUsageAccount,
			(report) => {
				pi.sendMessage({ customType: "claude-usage", content: report, display: true });
			},
			usageRuntime(),
		);
	});
	const unsubscribeAllUsage = pi.events.on("claude-bridge:usage-all-request", (payload) => {
		const request = payload as UsageAllRequest;
		if (request.accounts !== undefined) return;
		request.accounts = readConfiguredClaudeUsage();
	});
	pi.on("session_shutdown", () => {
		unsubscribeUsage();
		unsubscribeAllUsage();
	});
}
