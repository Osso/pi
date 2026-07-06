import { afterEach, describe, expect, it, vi } from "vitest";
import codexUsageExtension, {
	type CodexUsagePayload,
	formatCodexUsage,
	mapCodexUsagePayload,
	resolveCodexAccountId,
	resolveCodexAccountInfo,
	resolveCodexDisplayEmail,
} from "../extensions/codex-usage/src/index.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";

function usagePayload(overrides: Partial<CodexUsagePayload> = {}): CodexUsagePayload {
	return {
		plan_type: "pro",
		rate_limit: {
			primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
			secondary_window: { used_percent: 84, limit_window_seconds: 604_800, reset_at: 1_800_604_800 },
		},
		credits: { has_credits: true, unlimited: false, balance: "9.99" },
		rate_limit_reset_credits: { available_count: 3 },
		...overrides,
	};
}

function tokenWithClaims(claims: unknown): string {
	return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

describe("codex usage extension", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("maps the Codex /wham/usage payload to displayable account usage", () => {
		const usage = mapCodexUsagePayload(usagePayload());

		expect(usage.planType).toBe("pro");
		expect(usage.accountId).toBeNull();
		expect(usage.resetCreditsAvailable).toBe(3);
		expect(usage.limits).toHaveLength(1);
		expect(usage.limits[0]).toMatchObject({
			limitId: "codex",
			primary: { usedPercent: 42, windowMinutes: 300, resetsAt: 1_800_000_000 },
			secondary: { usedPercent: 84, windowMinutes: 10_080, resetsAt: 1_800_604_800 },
			credits: { hasCredits: true, unlimited: false, balance: "9.99" },
		});
	});

	it("includes additional Codex rate limits", () => {
		const usage = mapCodexUsagePayload(
			usagePayload({
				additional_rate_limits: [
					{
						limit_name: "codex_weekly",
						metered_feature: "codex_weekly",
						rate_limit: {
							primary_window: { used_percent: 70, limit_window_seconds: 604_800, reset_at: 1_800_604_800 },
						},
					},
				],
			}),
		);

		expect(usage.limits.map((limit) => limit.limitId)).toEqual(["codex", "codex_weekly"]);
		expect(usage.limits[1].primary?.usedPercent).toBe(70);
	});

	it("formats account usage and reset credit availability", () => {
		const usage = { ...mapCodexUsagePayload(usagePayload()), accountId: "acct_123", email: "user@example.com" };
		const text = formatCodexUsage(usage);

		expect(text).toContain("OpenAI Codex usage");
		expect(text).toContain("User: user@example.com");
		expect(text).toContain("Account: acct_123");
		expect(text).toContain("Plan: pro");
		expect(text).toContain("Reset credits: 3 available");
		expect(text).toContain("codex: 5-hour usage 42% of 300m window resets 2027-01-15 08:00");
		expect(text).toContain("codex: weekly usage 84% of 10080m window resets 2027-01-22 08:00");
		expect(text).toContain("codex: credits balance 9.99");
	});

	it("asks for confirmation before resetting usage", async () => {
		const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
		const pi = {
			registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) {
				commands.set(name, options);
			},
			sendMessage: vi.fn(),
		} as unknown as ExtensionAPI;
		codexUsageExtension(pi);
		const usageCommand = commands.get("usage");
		if (!usageCommand) throw new Error("usage command was not registered");

		const confirm = vi.fn(async () => false);
		const token = tokenWithClaims({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(usagePayload()), { status: 200 })),
		);
		const ctx = {
			model: undefined,
			modelRegistry: {
				authStorage: {
					get: () => null,
					getApiKey: async () => token,
				},
			},
			ui: {
				confirm,
				notify: vi.fn(),
			},
		} as unknown as ExtensionCommandContext;

		await usageCommand.handler("reset", ctx);

		expect(confirm).toHaveBeenCalledWith(
			"Are you sure you want to reset OpenAI Codex usage?",
			"This will consume 1 of 3 available reset credits.",
		);
	});

	it("extracts the ChatGPT account id from the Codex access token", () => {
		const token = tokenWithClaims({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } });

		expect(resolveCodexAccountId(token)).toBe("acct_123");
	});

	it("extracts the user email from standard ChatGPT token claims", () => {
		const payload = Buffer.from(
			JSON.stringify({
				email: "user@example.com",
				"https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
			}),
		).toString("base64url");
		const token = `header.${payload}.signature`;

		expect(resolveCodexAccountInfo(token)).toEqual({ accountId: "acct_123", email: "user@example.com" });
	});

	it("prefers a stored email when the access token has no email claim", () => {
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } }),
		).toString("base64url");
		const token = `header.${payload}.signature`;

		expect(resolveCodexDisplayEmail(token, "stored@example.com")).toBe("stored@example.com");
	});
});
