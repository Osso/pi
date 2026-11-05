import { afterEach, describe, expect, it, vi } from "vitest";
import codexUsageExtension, {
	formatDeepseekUsage,
	mapDeepseekBalance,
	mapOpencodeGoUsage,
	mapOpenGroveUsage,
	mapOpenRouterUsage,
} from "../extensions/codex-usage/src/index.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";

const USAGE_URLS = {
	opencodeGo: "https://opencode.ai/zen/go/v1/usage",
	openGrove: "https://api.pgsgrove.com/v1/usage",
	openRouterKey: "https://openrouter.ai/api/v1/key",
	openRouterCredits: "https://openrouter.ai/api/v1/credits",
	deepseekBalance: "https://api.deepseek.com/user/balance",
};

function opencodeGoPayload() {
	return {
		usage: {
			rolling: { status: "ok", percent: 32, resetsAt: "2026-11-05T08:07:54.000Z" },
			weekly: { status: "ok", percent: 21, resetsAt: "2026-11-09T00:00:00.000Z" },
			monthly: { status: "ok", percent: 10, resetsAt: "2026-12-04T21:17:30.000Z" },
		},
	};
}

function openGrovePayload() {
	return {
		object: "usage",
		weekly_used_percent: 1.7,
		daily_used_percent: 5.7,
		weekly_resets_at: "2026-11-12T00:27:51.234561+00:00",
		daily_resets_at: "2026-11-06T00:27:51.234561+00:00",
	};
}

function openRouterKeyPayload(limit: number, remaining: number) {
	return { data: { label: "sk-or-v1-d5c", limit, limit_remaining: remaining, limit_reset: "weekly" } };
}

function openRouterCreditsPayload(total: number, usage: number) {
	return { data: { total_credits: total, total_usage: usage } };
}

function deepseekBalancePayload() {
	return {
		is_available: true,
		balance_infos: [{ currency: "USD", total_balance: "50.00", granted_balance: "0.00" }],
	};
}

function reportLines(sendMessage: ReturnType<typeof vi.fn>): string[] {
	expect(sendMessage).toHaveBeenCalledTimes(1);
	const message = sendMessage.mock.calls[0][0] as { customType: string; content: string };
	expect(message.customType).toBe("usage-deepseek");
	return message.content.split("\n").map((line) => line.trim().replace(/ +/g, " "));
}

function registerUsage(options: { loggedIn?: (providerId: string) => boolean; failing?: string } = {}) {
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const sendMessage = vi.fn();
	const pi = {
		events: { emit: vi.fn() },
		registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
			commands.set(name, command);
		},
		sendMessage,
	} as unknown as ExtensionAPI;
	codexUsageExtension(pi);
	const command = commands.get("usage");
	if (!command) throw new Error("usage command was not registered");

	const loggedIn = options.loggedIn ?? (() => true);
	const getApiKey = vi.fn(async (providerId?: string) => `key-${providerId}`);
	const ctx = {
		isIdle: () => true,
		model: { provider: "openrouter", api: "openai-completions" },
		modelRegistry: {
			authStorage: {
				has: (providerId: string) => loggedIn(providerId),
				getApiKey,
				get: () => null,
			},
		},
		ui: { notify: vi.fn(), confirm: vi.fn(async () => true) },
	} as unknown as ExtensionCommandContext;

	const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
		const url = String(input);
		if (options.failing && url === options.failing) return new Response("boom", { status: 500 });
		switch (url) {
			case USAGE_URLS.opencodeGo:
				return Response.json(opencodeGoPayload());
			case USAGE_URLS.openGrove:
				return Response.json(openGrovePayload());
			case USAGE_URLS.openRouterKey:
				return Response.json(openRouterKeyPayload(1000, 999.99));
			case USAGE_URLS.openRouterCredits:
				return Response.json(openRouterCreditsPayload(2100, 1923.314149318));
			case USAGE_URLS.deepseekBalance:
				return Response.json(deepseekBalancePayload());
			default:
				throw new Error(`unexpected fetch ${url}`);
		}
	});
	vi.stubGlobal("fetch", fetch);
	return { command, ctx, sendMessage, fetch, getApiKey };
}

afterEach(() => vi.unstubAllGlobals());

describe("DeepSeek usage payload mapping", () => {
	it("maps OpenCode Go rolling, weekly and monthly windows with ISO resets", () => {
		expect(mapOpencodeGoUsage(opencodeGoPayload())).toEqual({
			day: { percent: 32, resetsAt: Date.parse("2026-11-05T08:07:54.000Z") / 1000 },
			week: { percent: 21, resetsAt: Date.parse("2026-11-09T00:00:00.000Z") / 1000 },
			month: { percent: 10, resetsAt: Date.parse("2026-12-04T21:17:30.000Z") / 1000 },
		});
	});

	it("maps Open Grove daily and weekly percentages and leaves the month unreported", () => {
		expect(mapOpenGroveUsage(openGrovePayload())).toEqual({
			day: { percent: 5.7, resetsAt: Math.round(Date.parse("2026-11-06T00:27:51.234561Z") / 1000) },
			week: { percent: 1.7, resetsAt: Math.round(Date.parse("2026-11-12T00:27:51.234561Z") / 1000) },
			month: null,
		});
	});

	it("derives OpenRouter weekly usage from the key limit and remaining credits from the credits endpoint", () => {
		const usage = mapOpenRouterUsage(
			openRouterKeyPayload(1000, 999.99),
			openRouterCreditsPayload(2100, 1923.314149318),
		);
		expect(usage.week?.percent).toBeCloseTo(0.001, 6);
		expect(usage.week?.resetsAt).toBeNull();
		expect(usage.balance).toBe("$176.69");
	});

	it("reports no OpenRouter percentage when the key has no limit", () => {
		expect(mapOpenRouterUsage(openRouterKeyPayload(0, 0), openRouterCreditsPayload(10, 4))).toEqual({
			week: null,
			balance: "$6.00",
		});
	});

	it("reads the USD balance and reports nothing for malformed payloads", () => {
		expect(mapDeepseekBalance(deepseekBalancePayload())).toEqual({ balance: "$50.00" });
		expect(mapDeepseekBalance({ is_available: false, balance_infos: [] })).toEqual({ balance: null });
		expect(mapDeepseekBalance(null)).toEqual({ balance: null });
	});

	it("keeps unavailable values as '-' rather than zero and marks unreported providers", () => {
		const table = formatDeepseekUsage([
			{
				provider: "opencode-go",
				day: { percent: 32, resetsAt: 1_800_000_000 },
				week: null,
				month: null,
				balance: null,
			},
			{ provider: "commandcode", day: null, week: null, month: null, balance: null, status: "not reported" },
		]);
		const [header, opencodeLine, commandLine] = table.split("\n");
		expect(header).toContain("Resets Central (day | week | month)");
		expect(opencodeLine).toContain("32%");
		expect(opencodeLine).toContain("-");
		expect(commandLine).toContain("not reported");
	});
});

describe("registered /usage deepseek", () => {
	it("reports every pool provider and sends one usage-deepseek message", async () => {
		const h = registerUsage();
		await h.command.handler("deepseek", h.ctx);

		const lines = reportLines(h.sendMessage);
		expect(lines[0]).toContain("DeepSeek pool usage; - = not reported");
		expect(lines.join("\n")).toContain("32% 21% 10%");
		expect(lines.join("\n")).toContain("2026-11-05 02:07 | 2026-11-08 18:00 | 2026-12-04 15:17");
		expect(lines.find((line) => line.includes("commandcode"))).toContain("not reported");
		expect(lines.find((line) => line.includes("$50.00 deepseek"))).toBeDefined();
		expect(lines.find((line) => line.includes("$176.69"))).toContain("openrouter");
		expect(h.fetch).toHaveBeenCalledTimes(7);
	});

	it("marks providers without a stored credential as not logged in", async () => {
		const h = registerUsage({ loggedIn: (providerId) => providerId !== "deepseek" });
		await h.command.handler("deepseek", h.ctx);

		const lines = reportLines(h.sendMessage);
		expect(lines.find((line) => line.endsWith("deepseek not logged in"))).toBeDefined();
		expect(h.fetch).not.toHaveBeenCalledWith(USAGE_URLS.deepseekBalance, expect.anything());
	});

	it("keeps a failing provider as an error row without losing other providers", async () => {
		const h = registerUsage({ failing: USAGE_URLS.openGrove });
		await h.command.handler("deepseek", h.ctx);

		const lines = reportLines(h.sendMessage);
		expect(lines.find((line) => line.includes("error:"))).toContain("Open Grove usage request failed (500)");
		expect(lines.join("\n")).toContain("32% 21% 10%");
	});

	it("leaves /usage and /usage all routing unchanged", async () => {
		const h = registerUsage();
		await h.command.handler("nonsense", h.ctx);
		expect(h.sendMessage).not.toHaveBeenCalled();
		expect((h.ctx as unknown as { ui: { notify: ReturnType<typeof vi.fn> } }).ui.notify).toHaveBeenCalledWith(
			"Usage: /usage [all|deepseek|reset]",
			"warning",
		);
	});
});
