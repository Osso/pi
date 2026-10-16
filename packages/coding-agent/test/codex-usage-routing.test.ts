import { afterEach, describe, expect, it, vi } from "vitest";
import codexUsageExtension from "../extensions/codex-usage/src/index.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";

type UsageRequest = { args: string; ctx: ExtensionCommandContext; handled?: Promise<void> };

function registerUsage(provider: string) {
	const events = createEventBus();
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const sendMessage = vi.fn();
	const pi = {
		events,
		registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
			commands.set(name, command);
		},
		sendMessage,
	} as unknown as ExtensionAPI;
	codexUsageExtension(pi);
	const command = commands.get("usage");
	if (!command) throw new Error("usage command was not registered");
	const claims = { email: "usage@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "acct_usage" } };
	const token = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
	const getApiKey = vi.fn(async (_provider?: string) => token);
	const has = vi.fn((providerId: string) => providerId !== "openai-codex-team");
	const get = vi.fn(() => null);
	const notify = vi.fn();
	const confirm = vi.fn(async () => true);
	const isIdle = vi.fn(() => true);
	const ctx = {
		isIdle,
		model: { provider, api: "openai-codex-responses" },
		modelRegistry: { authStorage: { getApiKey, get, has } },
		ui: { notify, confirm },
	} as unknown as ExtensionCommandContext;
	const fetch = vi.fn<typeof globalThis.fetch>(async () => usageResponse(42, 3));
	vi.stubGlobal("fetch", fetch);
	return { command, events, ctx, getApiKey, get, has, notify, confirm, isIdle, sendMessage, fetch, token };
}

function usageResponse(usedPercent: number, resetCredits: number): Response {
	return Response.json({
		plan_type: "pro",
		rate_limit: { primary_window: { used_percent: usedPercent, limit_window_seconds: 18_000 } },
		rate_limit_reset_credits: { available_count: resetCredits },
	});
}

afterEach(() => vi.unstubAllGlobals());

function allUsageResponse(fiveHour = 10, weekly = 63): Response {
	return Response.json({
		plan_type: "pro",
		rate_limit: {
			// Deliberately reversed: identify windows by duration, not position.
			primary_window: { used_percent: weekly, limit_window_seconds: 604_800, reset_at: 1_792_476_000 },
			secondary_window: { used_percent: fiveHour, limit_window_seconds: 18_000, reset_at: 1_792_144_800 },
		},
	});
}

function reportLines(h: ReturnType<typeof registerUsage>): string[] {
	expect(h.sendMessage).toHaveBeenCalledTimes(1);
	const message = h.sendMessage.mock.calls[0][0];
	expect(message).toMatchObject({ customType: "usage-all", display: true });
	return message.content.split("\n").map((line: string) => line.trim().replace(/ +/g, " "));
}

describe("registered /usage all", () => {
	it.each(["openai-codex-gc", "claude-bridge"])(
		"reports every account when selected provider is %s",
		async (provider) => {
			const h = registerUsage(provider);
			h.getApiKey.mockImplementation(async (id) => {
				const email = id === "openai-codex-gc" ? "gc@example.co.uk" : "user@example.com";
				return `header.${Buffer.from(JSON.stringify({ email, "https://api.openai.com/auth": { chatgpt_account_id: email } })).toString("base64url")}.signature`;
			});
			h.fetch.mockImplementation(async (_url, options) =>
				new Headers(options?.headers).get("chatgpt-account-id") === "gc@example.co.uk"
					? allUsageResponse(25, 75)
					: allUsageResponse(),
			);
			h.events.on("claude-bridge:usage-all-request", (data) => {
				(data as { accounts?: Promise<unknown> }).accounts = Promise.resolve([
					{
						account: "alessio",
						selected: true,
						fiveHour: { percent: 42, resetsAt: "2026-10-16T14:00:00Z" },
						weekly: { percent: 61, resetsAt: "2026-10-20T09:00:00Z" },
					},
					{ account: "gc", selected: false, error: "Claude usage HTTP 401: expired" },
				]);
			});
			h.events.on("claude-bridge:usage-request", () => {
				throw new Error("must not use Claude-only routing");
			});

			await h.command.handler(" all ", h.ctx);

			const lines = reportLines(h);
			expect(lines).toContain("Account usage (all accounts)");
			expect(lines).toContain("Claude alessio * 42% 2026-10-16 14:00 61% 2026-10-20 09:00");
			expect(lines).toContain("Claude gc error: Claude usage HTTP 401: expired");
			expect(lines).toContain(
				"Codex user@example.com (pro) [openai-codex] 10% 2026-10-16 10:00 63% 2026-10-20 06:00",
			);
			expect(lines).toContain(
				`Codex gc@example.co.uk (pro) [openai-codex-gc]${provider === "openai-codex-gc" ? " *" : ""} 25% 2026-10-16 10:00 75% 2026-10-20 06:00`,
			);
			expect(lines).toContain("Codex openai-codex-team not logged in");
		},
	);

	it("isolates a failed Codex request and redacts credentials from its error", async () => {
		const h = registerUsage("openai-codex");
		h.fetch.mockResolvedValueOnce(new Response(`upstream failed: Bearer ${h.token}\nnext line`, { status: 500 }));
		h.fetch.mockResolvedValueOnce(allUsageResponse());
		await h.command.handler("all", h.ctx);
		const lines = reportLines(h);
		expect(lines.some((line) => line.startsWith("Codex openai-codex * error:") && line.includes("500"))).toBe(true);
		expect(lines).toContain(
			"Codex usage@example.com (pro) [openai-codex-gc] 10% 2026-10-16 10:00 63% 2026-10-20 06:00",
		);
		expect(lines.join("\n")).not.toContain(h.token);
	});

	it("shows missing Claude bridge alongside available Codex rows", async () => {
		const h = registerUsage("openai-codex");
		h.fetch.mockImplementation(async () => allUsageResponse());
		await h.command.handler("all", h.ctx);
		const lines = reportLines(h);
		expect(lines).toContain("Claude bridge not loaded");
		expect(lines).toContain(
			"Codex usage@example.com (pro) [openai-codex] * 10% 2026-10-16 10:00 63% 2026-10-20 06:00",
		);
	});

	it("renders missing percentage and reset data as unavailable", async () => {
		const h = registerUsage("openai-codex");
		h.fetch.mockImplementation(async () =>
			Response.json({
				rate_limit: {
					primary_window: { limit_window_seconds: 18_000, reset_at: 1_792_159_200 },
					secondary_window: { used_percent: 28, limit_window_seconds: 604_800 },
				},
			}),
		);
		await h.command.handler("all", h.ctx);
		const lines = reportLines(h);
		expect(lines).toContain("Codex usage@example.com [openai-codex] * unavailable unavailable 28% unavailable");
		expect(lines.join("\n")).not.toMatch(/\b0%/);
	});

	it("renders the live weekly-only Codex payload without inventing 5-hour usage", async () => {
		const h = registerUsage("openai-codex");
		h.has.mockReturnValue(true);
		h.fetch.mockImplementation(async () =>
			Response.json({
				plan_type: "pro",
				rate_limit: {
					primary_window: {
						used_percent: 56,
						limit_window_seconds: 604_800,
						reset_after_seconds: 500_000,
						reset_at: 1_792_650_775,
					},
					secondary_window: null,
				},
				additional_rate_limits: null,
			}),
		);

		await h.command.handler("all", h.ctx);

		const lines = reportLines(h);
		for (const provider of ["openai-codex", "openai-codex-gc", "openai-codex-team"]) {
			expect(lines).toContain(
				`Codex usage@example.com (pro) [${provider}]${provider === "openai-codex" ? " *" : ""} unavailable unavailable 56% 2026-10-22 06:32`,
			);
		}
		expect(lines.join("\n")).not.toMatch(/\b0%/);
	});

	it.each([null, { percent: "42", resetsAt: null }, { percent: 42, resetsAt: "tomorrow" }])(
		"isolates malformed Claude entries (%j)",
		async (fiveHour) => {
			const h = registerUsage("openai-codex");
			h.events.on("claude-bridge:usage-all-request", (data) => {
				(data as { accounts?: Promise<unknown> }).accounts = Promise.resolve([
					fiveHour === null ? null : { account: "bad", selected: false, fiveHour, weekly: null },
					{ account: "valid", selected: false, fiveHour: null, weekly: { percent: 0, resetsAt: null } },
				]);
			});
			await h.command.handler("all", h.ctx);
			const lines = reportLines(h);
			expect(
				lines.some((line) => line.startsWith("Claude ") && line.includes("error:") && line.includes("malformed")),
			).toBe(true);
			expect(lines).toContain("Claude valid unavailable unavailable 0% unavailable");
		},
	);

	it.each(["rejected", "malformed"])("reports a %s Claude response without losing Codex rows", async (response) => {
		const h = registerUsage("openai-codex");
		h.events.on("claude-bridge:usage-all-request", (data) => {
			(data as { accounts?: Promise<unknown> }).accounts =
				response === "rejected"
					? Promise.reject(new Error("Claude usage HTTP 503"))
					: Promise.resolve({ bad: true });
		});
		await h.command.handler("all", h.ctx);
		const lines = reportLines(h);
		expect(lines.some((line) => line.startsWith("Claude error:"))).toBe(true);
		expect(lines).toContain("Codex openai-codex-team not logged in");
	});

	it("reads Claude and Codex concurrently and uses busy report delivery", async () => {
		const h = registerUsage("openai-codex");
		let release!: (accounts: unknown[]) => void;
		const accounts = new Promise<unknown[]>((resolve) => {
			release = resolve;
		});
		let fetched!: () => void;
		const fetching = new Promise<void>((resolve) => {
			fetched = resolve;
		});
		h.events.on("claude-bridge:usage-all-request", (data) => {
			(data as { accounts?: Promise<unknown> }).accounts = accounts;
		});
		h.fetch.mockImplementation(async () => {
			fetched();
			return allUsageResponse();
		});
		const operation = h.command.handler("all", h.ctx);
		await Promise.race([fetching, operation]);
		expect(h.fetch).toHaveBeenCalled();
		expect(h.sendMessage).not.toHaveBeenCalled();
		h.isIdle.mockReturnValue(false);
		release([]);
		await operation;
		reportLines(h);
		const message = h.sendMessage.mock.calls[0][0];
		expect(h.notify).toHaveBeenCalledExactlyOnceWith(message.content, "info");
		expect(h.sendMessage).toHaveBeenCalledWith(message, { deliverAs: "nextTurn" });
	});

	it("completes the all argument", () => {
		const h = registerUsage("openai-codex");
		expect(h.command.getArgumentCompletions?.("a")).toEqual([{ value: "all", label: "all" }]);
	});
});

const busyReports = [
	{
		args: "",
		credits: 3,
		responses: [usageResponse(42, 3)],
		confirmationCount: 0,
		requestCount: 1,
		content:
			"OpenAI Codex usage\nUser: usage@example.com\nAccount: acct_usage\nPlan: pro\nReset credits: 3 available\ncodex: 5-hour usage 42% of 300m window resets unknown",
	},
	{
		args: "reset",
		credits: 0,
		responses: [usageResponse(42, 0)],
		confirmationCount: 0,
		requestCount: 1,
		content:
			"OpenAI Codex usage\nUser: usage@example.com\nAccount: acct_usage\nPlan: pro\nReset credits: 0 available\ncodex: 5-hour usage 42% of 300m window resets unknown\n\nNo reset credits available.",
	},
	{
		args: "reset",
		credits: 3,
		responses: [usageResponse(42, 3), Response.json({ code: "reset", windows_reset: 1 }), usageResponse(0, 2)],
		confirmationCount: 1,
		requestCount: 3,
		content:
			"Consumed reset credit. Windows reset: 1\n\nOpenAI Codex usage\nUser: usage@example.com\nAccount: acct_usage\nPlan: pro\nReset credits: 2 available\ncodex: 5-hour usage 0% of 300m window resets unknown",
	},
];

describe("registered /usage provider routing", () => {
	it.each(["", "  ", "reset", "unknown"])(
		"dispatches Claude args %j and awaits the claimed operation",
		async (args) => {
			const h = registerUsage("claude-bridge");
			let release!: () => void;
			const pending = new Promise<void>((resolve) => {
				release = resolve;
			});
			let received: UsageRequest | undefined;
			h.events.on("claude-bridge:usage-request", (data) => {
				const request = data as UsageRequest;
				received = request;
				request.handled = pending.then(() => {
					request.ctx.ui.notify(args.trim() ? "Usage: /usage" : "Claude usage: 25%", "info");
				});
			});
			let finished = false;
			const operation = h.command.handler(args, h.ctx).then(() => {
				finished = true;
			});
			await Promise.resolve();
			expect(received?.args).toBe(args);
			expect(received?.ctx).toBe(h.ctx);
			expect(finished).toBe(false);
			expect(h.notify).not.toHaveBeenCalled();
			release();
			await operation;
			expect(finished).toBe(true);
			expect(h.notify).toHaveBeenCalledExactlyOnceWith(args.trim() ? "Usage: /usage" : "Claude usage: 25%", "info");
			expect(h.getApiKey).not.toHaveBeenCalled();
			expect(h.get).not.toHaveBeenCalled();
			expect(h.fetch).not.toHaveBeenCalled();
			expect(h.confirm).not.toHaveBeenCalled();
			expect(h.sendMessage).not.toHaveBeenCalled();
		},
	);

	it.each(["", "reset", "unknown"])("fails closed for Claude args %j without a listener", async (args) => {
		const h = registerUsage("claude-bridge");
		await h.command.handler(args, h.ctx);
		expect(h.notify).toHaveBeenCalledExactlyOnceWith("Claude bridge usage handler unavailable.", "error");
		expect(h.getApiKey).not.toHaveBeenCalled();
		expect(h.get).not.toHaveBeenCalled();
		expect(h.fetch).not.toHaveBeenCalled();
		expect(h.confirm).not.toHaveBeenCalled();
		expect(h.sendMessage).not.toHaveBeenCalled();
	});

	it("requires the bridge listener to claim the operation synchronously", async () => {
		const h = registerUsage("claude-bridge");
		h.events.on("claude-bridge:usage-request", async (data) => {
			await Promise.resolve();
			(data as UsageRequest).handled = Promise.resolve();
		});
		await h.command.handler("", h.ctx);
		expect(h.notify).toHaveBeenCalledExactlyOnceWith("Claude bridge usage handler unavailable.", "error");
		expect(h.getApiKey).not.toHaveBeenCalled();
		expect(h.fetch).not.toHaveBeenCalled();
	});

	it("propagates failure from the bridge operation", async () => {
		const h = registerUsage("claude-bridge");
		h.events.on("claude-bridge:usage-request", (data) => {
			(data as UsageRequest).handled = Promise.reject(new Error("Claude usage request failed"));
		});
		await expect(h.command.handler("", h.ctx)).rejects.toThrow("Claude usage request failed");
		expect(h.notify).not.toHaveBeenCalled();
		expect(h.getApiKey).not.toHaveBeenCalled();
		expect(h.fetch).not.toHaveBeenCalled();
	});

	it("keeps OpenAI reads on the Codex endpoint with the current account credentials", async () => {
		const h = registerUsage("openai-codex");
		const bridgeRequests: unknown[] = [];
		h.events.on("claude-bridge:usage-request", (request) => bridgeRequests.push(request));
		h.fetch.mockResolvedValueOnce(usageResponse(42, 3));
		await h.command.handler("  ", h.ctx);
		expect(bridgeRequests).toEqual([]);
		expect(h.getApiKey).toHaveBeenCalledExactlyOnceWith("openai-codex", { includeFallback: false });
		expect(h.fetch).toHaveBeenCalledTimes(1);
		const [url, options] = h.fetch.mock.calls[0];
		expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
		const headers = new Headers(options?.headers);
		expect(headers.get("authorization")).toBe(`Bearer ${h.token}`);
		expect(headers.get("chatgpt-account-id")).toBe("acct_usage");
		expect(h.sendMessage).toHaveBeenCalledExactlyOnceWith({
			customType: "codex-usage",
			content:
				"OpenAI Codex usage\nUser: usage@example.com\nAccount: acct_usage\nPlan: pro\nReset credits: 3 available\ncodex: 5-hour usage 42% of 300m window resets unknown",
			display: true,
		});
	});

	it("keeps OpenAI reset confirmation, credit consumption, and refreshed usage", async () => {
		const h = registerUsage("openai-codex");
		const bridgeRequests: unknown[] = [];
		h.events.on("claude-bridge:usage-request", (request) => bridgeRequests.push(request));
		h.fetch
			.mockResolvedValueOnce(usageResponse(42, 3))
			.mockResolvedValueOnce(Response.json({ code: "reset", windows_reset: 1 }))
			.mockResolvedValueOnce(usageResponse(0, 2));
		await h.command.handler(" reset ", h.ctx);
		expect(bridgeRequests).toEqual([]);
		expect(h.confirm).toHaveBeenCalledExactlyOnceWith(
			"Are you sure you want to reset OpenAI Codex usage?",
			"This will consume 1 of 3 available reset credits.",
		);
		expect(h.fetch.mock.calls.map(([url]) => url)).toEqual([
			"https://chatgpt.com/backend-api/wham/usage",
			"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
			"https://chatgpt.com/backend-api/wham/usage",
		]);
		const options = h.fetch.mock.calls[1][1];
		expect(options?.method).toBe("POST");
		expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer ${h.token}`);
		expect(JSON.parse(String(options?.body))).toEqual({ redeem_request_id: expect.any(String) });
		expect(h.sendMessage).toHaveBeenCalledExactlyOnceWith({
			customType: "codex-usage",
			content:
				"Consumed reset credit. Windows reset: 1\n\nOpenAI Codex usage\nUser: usage@example.com\nAccount: acct_usage\nPlan: pro\nReset credits: 2 available\ncodex: 5-hour usage 0% of 300m window resets unknown",
			display: true,
		});
	});
});

describe("registered /usage busy delivery", () => {
	it.each(busyReports)(
		"shows the full busy Codex report immediately for $args with $credits credits",
		async ({ args, responses, confirmationCount, requestCount, content }) => {
			const h = registerUsage("openai-codex");
			h.isIdle.mockReturnValue(false);
			for (const response of responses) h.fetch.mockResolvedValueOnce(response);
			await h.command.handler(args, h.ctx);
			expect(h.notify).toHaveBeenCalledExactlyOnceWith(content, "info");
			expect(h.sendMessage).toHaveBeenCalledExactlyOnceWith(
				{ customType: "codex-usage", content, display: true },
				{ deliverAs: "nextTurn" },
			);
			expect(h.notify.mock.invocationCallOrder[0]).toBeLessThan(h.sendMessage.mock.invocationCallOrder[0]);
			expect(h.confirm).toHaveBeenCalledTimes(confirmationCount);
			expect(h.fetch).toHaveBeenCalledTimes(requestCount);
		},
	);

	it.each([true, false])("uses delivery-time idle state when a fetch starts with idle=%s", async (initiallyIdle) => {
		const h = registerUsage("openai-codex");
		h.isIdle.mockReturnValue(initiallyIdle);
		let release!: (response: Response) => void;
		const pending = new Promise<Response>((resolve) => {
			release = resolve;
		});
		let started!: () => void;
		const fetching = new Promise<void>((resolve) => {
			started = resolve;
		});
		h.fetch.mockImplementationOnce(() => {
			started();
			return pending;
		});
		const operation = h.command.handler("", h.ctx);
		await fetching;
		expect(h.notify).not.toHaveBeenCalled();
		expect(h.sendMessage).not.toHaveBeenCalled();
		h.isIdle.mockReturnValue(!initiallyIdle);
		release(usageResponse(42, 3));
		await operation;
		const content =
			"OpenAI Codex usage\nUser: usage@example.com\nAccount: acct_usage\nPlan: pro\nReset credits: 3 available\ncodex: 5-hour usage 42% of 300m window resets unknown";
		const message = { customType: "codex-usage", content, display: true };
		if (initiallyIdle) {
			expect(h.notify).toHaveBeenCalledExactlyOnceWith(content, "info");
			expect(h.sendMessage).toHaveBeenCalledExactlyOnceWith(message, { deliverAs: "nextTurn" });
		} else {
			expect(h.notify).not.toHaveBeenCalled();
			expect(h.sendMessage).toHaveBeenCalledExactlyOnceWith(message);
		}
	});

	it("keeps idle no-credit reports as custom messages without notification", async () => {
		const h = registerUsage("openai-codex");
		h.fetch.mockResolvedValueOnce(usageResponse(42, 0));
		await h.command.handler("reset", h.ctx);
		expect(h.notify).not.toHaveBeenCalled();
		expect(h.confirm).not.toHaveBeenCalled();
		expect(h.sendMessage).toHaveBeenCalledExactlyOnceWith({
			customType: "codex-usage",
			content:
				"OpenAI Codex usage\nUser: usage@example.com\nAccount: acct_usage\nPlan: pro\nReset credits: 0 available\ncodex: 5-hour usage 42% of 300m window resets unknown\n\nNo reset credits available.",
			display: true,
		});
	});

	it("keeps unknown OpenAI arguments as a usage warning without account access", async () => {
		const h = registerUsage("openai-codex");
		const bridgeRequests: unknown[] = [];
		h.events.on("claude-bridge:usage-request", (request) => bridgeRequests.push(request));
		await h.command.handler(" unknown ", h.ctx);
		expect(bridgeRequests).toEqual([]);
		expect(h.notify).toHaveBeenCalledExactlyOnceWith("Usage: /usage [all|reset]", "warning");
		expect(h.getApiKey).not.toHaveBeenCalled();
		expect(h.fetch).not.toHaveBeenCalled();
		expect(h.confirm).not.toHaveBeenCalled();
		expect(h.sendMessage).not.toHaveBeenCalled();
	});
});
