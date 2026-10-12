import "./interactive-pty-provider-preload.ts";
import { appendFileSync } from "node:fs";
// Capture native fetch before installing the override so CLI dispatcher setup preserves it.
import "../../../src/core/http-dispatcher.ts";

// No request in this fixture may reach a real account or provider.
globalThis.fetch = async (input, init) => {
	const url = input instanceof Request ? input.url : String(input);
	if (url !== "https://chatgpt.com/backend-api/wham/usage") {
		throw new Error(`Unexpected fetch in usage PTY fixture: ${url}`);
	}
	const log = process.env.PI_TEST_USAGE_FETCH_LOG;
	if (!log) throw new Error("PI_TEST_USAGE_FETCH_LOG is required");
	const headers = new Headers(init?.headers);
	appendFileSync(log, `${JSON.stringify({ account: headers.get("chatgpt-account-id") })}\n`);
	return Response.json({
		plan_type: "pro",
		rate_limit: {
			primary_window: { used_percent: 23, limit_window_seconds: 18000, reset_at: 1893456000 },
			secondary_window: { used_percent: 41, limit_window_seconds: 604800, reset_at: 1893456000 },
		},
		credits: { has_credits: true, balance: "12.50" },
		rate_limit_reset_credits: { available_count: 3 },
		additional_rate_limits: [
			{
				limit_name: "Review",
				metered_feature: "codex_review",
				rate_limit: { primary_window: { used_percent: 7, limit_window_seconds: 3600, reset_at: 1893456000 } },
			},
		],
	});
};
