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
	const getApiKey = vi.fn(async () => token);
	const get = vi.fn(() => null);
	const notify = vi.fn();
	const confirm = vi.fn(async () => true);
	const ctx = {
		model: { provider, api: "openai-codex-responses" },
		modelRegistry: { authStorage: { getApiKey, get } },
		ui: { notify, confirm },
	} as unknown as ExtensionCommandContext;
	const fetch = vi.fn<typeof globalThis.fetch>(async () => usageResponse(42, 3));
	vi.stubGlobal("fetch", fetch);
	return { command, events, ctx, getApiKey, get, notify, confirm, sendMessage, fetch, token };
}

function usageResponse(usedPercent: number, resetCredits: number): Response {
	return Response.json({
		plan_type: "pro",
		rate_limit: { primary_window: { used_percent: usedPercent, limit_window_seconds: 18_000 } },
		rate_limit_reset_credits: { available_count: resetCredits },
	});
}

describe("registered /usage provider routing", () => {
	afterEach(() => vi.unstubAllGlobals());

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

	it("keeps unknown OpenAI arguments as a usage warning without account access", async () => {
		const h = registerUsage("openai-codex");
		const bridgeRequests: unknown[] = [];
		h.events.on("claude-bridge:usage-request", (request) => bridgeRequests.push(request));
		await h.command.handler(" unknown ", h.ctx);
		expect(bridgeRequests).toEqual([]);
		expect(h.notify).toHaveBeenCalledExactlyOnceWith("Usage: /usage [reset]", "warning");
		expect(h.getApiKey).not.toHaveBeenCalled();
		expect(h.fetch).not.toHaveBeenCalled();
		expect(h.confirm).not.toHaveBeenCalled();
		expect(h.sendMessage).not.toHaveBeenCalled();
	});
});
